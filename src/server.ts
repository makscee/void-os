// server.ts — Hono app with all routes (Task 10)
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { listCatalogSkills } from "./catalog.ts";
import { decideInteractive } from "./interactive-decide.ts";
import { listSessions, statusFor } from "./sessions.ts";
import { buildLaunchArgv, buildAnswerArgv, spawnTurn, spawnRun, runTurn, readCcSessionId } from "./spawn.ts";
import { buildAgentLaunch, type AgentLaunch } from "./agents.ts";
import { drain, type DrainOpts } from "./drain.ts";
import { renderDashboard, renderShell, renderPageShell, placeholderBody, workingPage, stoppedBody, ackFragment } from "./render.ts";
import { killProcessTree } from "./kill.ts";
import { sessionDir, bodyPath, errorPath, readConfig, resolveRunner, pidPath, stopPath, lastOpenedPath } from "./paths.ts";
import { homedir } from "node:os";
import { realDeps } from "./preflight.ts";
import { parseTranscript, locateTranscript, renderTranscript } from "./transcript.ts";
import { handleHookEvent, runIdForSession, type HookPayload, type HookDecision } from "./hooks-endpoint.ts";
import { getExecution, setExecutionFail, upsertTrigger, getTrigger } from "./registry.ts";
import { appendEvent } from "./events.ts";
import { killSession, hasSession, switchClient, sendKeys, hasAttachedClient, sendAfterRespawn } from "./tmux.ts";
import { respawnSession } from "./resume.ts";
import { attachInvocation } from "./attach.ts";
import { bodyHasRealContent, isResumable } from "./view-state.ts";
import { fireTrigger, type SpawnFn } from "./triggers-fire.ts";
import { listPendingDecisions } from "./decision.ts";
import { readAudit } from "./audit.ts";
import {
  gateCreate, gatePatch, gateEdit, gateDelete, gateWriteFile,
  listVaultSkills, viewVaultSkill,
} from "./skill-manage.ts";
import { HTMX_MIN_JS } from "./htmx-runtime.ts";
import { SORTABLE_MIN_JS } from "./sortable-runtime.ts";
import { readManifest, extractDataSource, dataSourceMtime, renderBoardData } from "./pages.ts";
import { createVaultMcpServer } from "./vault-mcp.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = join(repoRoot, "catalog");

/**
 * Apply the SAME body pipeline as GET /s/:uuid/body to a panel's html (VOS-225 §3.3):
 * light-theme wrap for bare fragments, <base target="_top"> for full docs, vendored htmx
 * injection, and {{VOS_SLUG}} substitution. Shared so the page route mirrors the session route.
 */
function renderPanelBody(html: string, slug: string): string {
  if (!html.includes("<html")) {
    html = `<!doctype html><html><head><meta charset="utf-8"><base target="_top"><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  background:#ffffff;color:#1a1a1a;padding:1rem;line-height:1.5}
</style></head><body>${html}</body></html>`;
  } else if (html.includes("<head>")) {
    html = html.replace("<head>", `<head><base target="_top">`);
  } else if (html.includes("<head ")) {
    html = html.replace(/<head(\s[^>]*)?>/, (m) => m.slice(0, -1) + `><base target="_top">`);
  } else {
    html = `<base target="_top">` + html;
  }
  const htmxTag = `<script src="/assets/htmx.min.js"></script>`;
  if (html.includes("</head>")) html = html.replace("</head>", `${htmxTag}</head>`);
  else html = htmxTag + html;
  return html.replaceAll("{{VOS_SLUG}}", slug);
}

/** Build the real DrainOpts for a server-side drain (wires actual gh/git/bun callbacks). */
export function buildDrainOptsFor(vault: string, issueNum: number, worktree: string, runner: string, max: number): DrainOpts {
  const sh = async (cmd: string[]) => {
    const p = Bun.spawn(cmd, { cwd: worktree, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  };
  const skillPath = join(catalogRoot, "skills", "ralph", "SKILL.md");
  return {
    vault, worktree, issueNum, runner, skill: "ralph",
    skillPath: existsSync(skillPath) ? skillPath : undefined,
    max,
    fetchBody: async () => (await sh(["gh", "issue", "view", String(issueNum), "--json", "body", "-q", ".body"])).out.trim(),
    writeBody: async (body) => {
      const p = Bun.spawn(["gh", "issue", "edit", String(issueNum), "--body-file", "-"], { cwd: worktree, stdin: "pipe" });
      p.stdin.write(body); p.stdin.end(); await p.exited;
    },
    runGate: async (check) => {
      const proc = Bun.spawn(["bash", "-lc", check], { cwd: worktree, stdout: "ignore", stderr: "ignore" });
      return await proc.exited;
    },
    commit: async (message) => { await sh(["git", "add", "-A"]); await sh(["git", "commit", "-m", message]); },
    commentDrained: async () => {
      const branch = `ralph/issue-${issueNum}`;
      await sh(["gh", "issue", "comment", String(issueNum), "--body",
        `Drained locally on \`${branch}\`, unpushed (no-push PoC posture). All boxes checked; commits live in the worktree only.`]);
    },
  };
}

export function makeApp(vault: string, db: Database, spawnFn?: SpawnFn) {
  const app = new Hono();

  // GET / — dashboard: skill buttons + session list + relay status banner
  app.get("/", async (c) => {
    const status = await realDeps.vcStatus();
    const cfg = readConfig(vault);
    return c.html(
      renderDashboard(listVaultSkills(vault), listSessions(vault, db), { authed: status.ok }, cfg, listPendingDecisions(vault), readManifest(vault).pages),
    );
  });

  // POST /hook?run=<run-id> — CC HTTP hook sink. Maps a lifecycle event to a registry
  // transition. Always 200 (a hook must never see a 5xx — it would stall the Run).
  // Stop-hook nudge: if handleHookEvent returns a HookDecision, relay it so the command-hook
  // relay can echo it to CC stdout (causing CC to block the stop and re-prompt the agent).
  app.post("/hook", async (c) => {
    let payload: HookPayload;
    try { payload = (await c.req.json()) as HookPayload; }
    catch { return c.json({ ok: false }, 200); }
    let runId = c.req.query("run") ?? "";
    // Vault-level (hand-launched) path: no ?run= param → derive runId from session_id
    if (!runId && typeof payload.session_id === "string" && payload.session_id) {
      runId = runIdForSession(payload.session_id);
    }
    let decision: HookDecision | undefined;
    try { decision = handleHookEvent(db, vault, runId, payload, Date.now(), killSession); }
    catch { /* never fail a hook */ }
    if (decision) return c.json(decision, 200);
    return c.json({ ok: true }, 200);
  });

  // GET /audit?path=&agent=&since= — VOS-226 (contract §4.4): inspect the vault-write audit log.
  // Filters AND-ed; `since` = epoch-ms lower bound. Returns the matching JSONL lines (one per line),
  // file (append) order. The file IS the interface — this is a convenience reader, never a writer.
  app.get("/audit", (c) => {
    const path = c.req.query("path");
    const agent = c.req.query("agent");
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined && sinceRaw !== "" ? Number(sinceRaw) : undefined;
    const lines = readAudit(vault, {
      path,
      agent,
      since: since !== undefined && Number.isFinite(since) ? since : undefined,
    });
    return c.text(lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""),
      200, { "content-type": "application/x-ndjson" });
  });

  // POST /launch — relay auth guard, create session dir, write placeholder, spawn tmux Run, redirect
  app.post("/launch", async (c) => {
    // Bug #4 fix: check relay auth BEFORE creating any session state
    const status = await realDeps.vcStatus();
    if (!status.ok) {
      return c.html(`<!doctype html><meta charset=utf8><title>relay not authed</title>
<style>body{font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem;background:#0a0f1a;color:#e2e8f0}
h2{color:#f87171;margin-bottom:1rem}.cmd{background:#1e293b;padding:.5rem .75rem;border-radius:.375rem;
font-family:monospace;font-size:14px;color:#7dd3fc;display:inline-block;margin:.25rem 0}
a{color:#93c5fd}</style>
<h2>relay not authenticated</h2>
<p>The relay is not authed — vc sessions will fail immediately. Run:</p>
<p><span class="cmd">vc login</span></p>
<p>then <a href="/">return to dashboard</a> and try again.</p>`, 403);
    }

    const body = await c.req.parseBody();
    const skill = String(body.skill ?? "");
    const text = String(body.text ?? "");
    const runnerLabel = String(body.runner ?? "");
    const cfg = readConfig(vault);
    const runnerCommand = resolveRunner(cfg, runnerLabel || undefined);
    const daemonUrl = `http://127.0.0.1:${cfg.port}`;
    // Look up the skill's declared output_target so interactive launches also track it.
    const catalogSkills = listCatalogSkills(catalogRoot);
    const skillMeta = catalogSkills.find((s) => s.name === skill);

    // Optional agent param (VOS-200): wrap the launch with the agent's config.
    const agentName = String(body.agent ?? "").trim() || null;
    let agentLaunch: AgentLaunch | null = null;
    if (agentName) {
      try {
        agentLaunch = buildAgentLaunch(vault, agentName);
      } catch {
        return c.html(`<!doctype html><meta charset=utf8><title>agent not found</title>
<body><p>agent <code>${agentName}</code> not found — create <code>agents/${agentName}.md</code> first.</p></body>`, 404);
      }
    }

    const outputTarget = agentLaunch ? agentLaunch.outputTarget : (skillMeta?.outputTarget ?? null);
    // VOS-206: decide interactive mode per skill heuristic/flag.
    // Conversational skills (chat/onboarding/work) launch as interactive tmux REPL.
    // Pure-worker skills and agent-only launches stay print-mode (forcePrint:true).
    const interactive = skillMeta ? decideInteractive(skillMeta) : false;
    const { runId, tmuxSession } = spawnRun({
      db, vault, daemonUrl, skill: skill || null, agent: agentName,
      runnerCommand, now: Date.now(), outputTarget,
      // interactive sessions use the tmux REPL path (forcePrint:false);
      // print-mode sessions keep forcePrint:true so hooks fire and body.html is the output.
      interactive,
      forcePrint: interactive ? false : true,
      addDirs: agentLaunch?.addDirs,
      mcpConfigPath: agentLaunch?.mcpConfigPath ?? null,
      appendSystemPrompt: agentLaunch?.appendSystemPrompt,
      bodyMessage: agentLaunch?.bodyMessage,
    });
    // Keep the body.html render shell working: seed a placeholder + meta under the runId key.
    const dir = sessionDir(vault, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session-meta.json"),
      JSON.stringify({ skill: skill || null, agent: agentName, launchedAt: Date.now(), text, tmuxSession, runner: runnerCommand, interactive }),
    );
    writeFileSync(bodyPath(vault, runId), placeholderBody(skill));
    return c.redirect(`/s/${runId}`);
  });

  // GET /assets/htmx.min.js — vendored htmx runtime (VOS-211). Served by the daemon, not a CDN.
  app.get("/assets/htmx.min.js", (c) =>
    new Response(HTMX_MIN_JS, { headers: { "content-type": "application/javascript; charset=utf-8" } }));

  // GET /assets/sortable.min.js — vendored SortableJS runtime (VOS-227). Used by the kanban
  // scaffold for drag-reorder. Served by the daemon, not a CDN (iframe-CSP-safe, mirrors htmx).
  app.get("/assets/sortable.min.js", (c) =>
    new Response(SORTABLE_MIN_JS, { headers: { "content-type": "application/javascript; charset=utf-8" } }));

  // GET /s/:uuid — iframe shell wrapping the session body
  app.get("/s/:uuid", (c) => {
    const uuid = c.req.param("uuid");
    // Read skill name from session-meta.json (interactive no longer gates view affordances — VOS-210).
    const metaPath = join(sessionDir(vault, uuid), "session-meta.json");
    let sessionName: string | undefined;
    if (existsSync(metaPath)) {
      try {
        const m = JSON.parse(readFileSync(metaPath, "utf8")) as { skill?: string; text?: string };
        if (m.skill) sessionName = m.text ? `${m.skill} — ${m.text.slice(0, 40)}` : m.skill;
      } catch { /* use fallback */ }
    }
    // Stamp last-opened.txt so needsAttention tracking knows when the operator viewed this session.
    try { writeFileSync(lastOpenedPath(vault, uuid), String(Date.now())); } catch { /* ignore */ }
    // State-derived view: compute resumable + hasReal from live state (not frozen spawn flags).
    const ccId = readCcSessionId(vault, uuid);
    const resumable = isResumable({ liveTmux: hasSession(`vos-run-${uuid}`), ccId });
    const resumeCmd = ccId ? `cd ${vault} && vc -- --resume ${ccId}` : undefined;
    const bp = bodyPath(vault, uuid);
    const hasReal = existsSync(bp) && bodyHasRealContent(readFileSync(bp, "utf8"));
    return c.html(renderShell(uuid, vault, sessionName, resumeCmd, resumable, hasReal, listSessions(vault, db), "working", readManifest(vault).pages));
  });

  // GET /s/:uuid/body — serves the session's body.html, appends error banner if error.txt present.
  // Exception: suppress a "timeout" error when body.html was updated AFTER error.txt was written —
  // the skill completed during SIGTERM cleanup, so the timeout was premature and the output is valid.
  //
  // Bare-fragment wrap: skills like smoke-test write minimal HTML without <html>/<style>. On dark-mode
  // systems the browser renders bare fragments with dark background + dark text = unreadable. Wrap bare
  // fragments in a minimal light-theme document so content is always readable regardless of system theme.
  app.get("/s/:uuid/body", (c) => {
    const uuid = c.req.param("uuid");
    const bp = bodyPath(vault, uuid);
    if (!existsSync(bp)) return c.text("no body yet", 404);
    let html = readFileSync(bp, "utf8");
    // Inject light-theme base if it's a bare fragment (no <html> tag).
    if (!html.includes("<html")) {
      html = `<!doctype html><html><head><meta charset="utf-8"><base target="_top"><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  background:#ffffff;color:#1a1a1a;padding:1rem;line-height:1.5}
</style></head><body>${html}</body></html>`;
    } else {
      // Full HTML documents: inject base target=_top so in-body navigation escapes the iframe
      // (prevents wrapper stacking when the user clicks a dashboard link inside the session body).
      if (html.includes("<head>")) {
        html = html.replace("<head>", `<head><base target="_top">`);
      } else if (html.includes("<head ")) {
        html = html.replace(/<head(\s[^>]*)?>/, (m) => m.slice(0, -1) + `><base target="_top">`);
      } else {
        html = `<base target="_top">` + html;
      }
    }
    // VOS-211: inject vendored htmx (loaded from our asset route, never a CDN) + substitute the
    // {{VOS_UUID}} sentinel so the agent can author a stable form template: hx-post="/s/{{VOS_UUID}}/act".
    const htmxTag = `<script src="/assets/htmx.min.js"></script>`;
    if (html.includes("</head>")) html = html.replace("</head>", `${htmxTag}</head>`);
    else html = htmxTag + html;
    html = html.replaceAll("{{VOS_UUID}}", uuid);

    const ep = errorPath(vault, uuid);
    // Never show the error banner for stopped sessions — the banner is a live-run artifact.
    const isStopped = existsSync(stopPath(vault, uuid));
    if (existsSync(ep) && !isStopped) {
      const errContent = readFileSync(ep, "utf8");
      const bodyMtime = statSync(bp).mtimeMs;
      const errMtime = statSync(ep).mtimeMs;
      // If body.html is newer than error.txt and the error was a timeout, the skill
      // completed after SIGTERM — suppress the banner so the user sees the clean output.
      const suppressTimeout = errContent.startsWith("timeout") && bodyMtime > errMtime;
      if (!suppressTimeout) {
        html += `<pre style="color:#a00;border-top:1px solid #a00;padding:1rem">${
          readFileSync(ep, "utf8")
        }</pre>`;
      }
    }
    return c.html(html);
  });

  // GET /s/:uuid/transcript — minimal escaped HTML fragment of the CC conversation.
  // Empty body when no transcript exists yet (run not started) or uuid is malformed.
  // The route param is a void-os runId (exec-...); the CC session id is resolved via
  // readCcSessionId which checks cc-actual-session.txt first, then falls back to the
  // --session-id hint in cc-command.txt so sessions without cc-actual still get a transcript.
  app.get("/s/:uuid/transcript", (c) => {
    const uuid = c.req.param("uuid");
    const ccId = readCcSessionId(vault, uuid);
    if (!ccId) return c.html("");
    const path = locateTranscript(ccId);
    if (!path) return c.html("");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return c.html("");
    }
    return c.html(renderTranscript(parseTranscript(raw)));
  });

  // GET /s/:uuid/body/assets/* — static assets written by the session alongside body.html
  app.get("/s/:uuid/body/assets/*", (c) => {
    const uuid = c.req.param("uuid");
    const rel = c.req.path.split("/assets/")[1];
    const p = join(sessionDir(vault, uuid), "assets", rel);
    if (!existsSync(p)) return c.text("not found", 404);
    return new Response(Bun.file(p));
  });

  // POST /drain — kick off an Issue-drain in a pre-created worktree. Fire-and-forget.
  app.post("/drain", async (c) => {
    const body = await c.req.parseBody();
    const issueNum = parseInt(String(body.issue ?? ""), 10);
    if (!Number.isFinite(issueNum)) return c.text("bad issue number", 400);
    const worktree = join(homedir(), "void-os-wt", `issue-${issueNum}`);
    if (!existsSync(worktree)) return c.text(`worktree ${worktree} does not exist — create it first`, 412);
    const runner = resolveRunner(readConfig(vault));
    const max = Number(body.max ?? 12);
    void drain(buildDrainOptsFor(vault, issueNum, worktree, runner, max));
    return c.redirect("/");
  });

  // POST /s/:uuid/stop — stop a Run: kill tmux session (interactive) or pid tree (drain headless),
  // mark the registry row exited, halt any drain loop. "Stop means stop": no respawn.
  app.post("/s/:uuid/stop", async (c) => {
    const sessionId = c.req.param("uuid");
    // Idempotent: stopping an already-stopped session is a no-op.
    if (existsSync(stopPath(vault, sessionId))) return c.redirect("/");
    // Write the terminal marker FIRST so the race guard in spawn.ts sees it
    // before the killed child's late exit handler can fire.
    writeFileSync(stopPath(vault, sessionId), "stopped\n");

    // Kill the execution's tmux session + mark the execution ended in the registry.
    const exec = getExecution(db, sessionId);
    if (exec && exec.ended_at == null) {
      const stopNow = Date.now();
      killSession(exec.tmux_session); // tmux kill-session = stop (folds VOS-187 stop semantics)
      setExecutionFail(db, sessionId, "operator-stopped", stopNow); // operator-stopped = non-clean exit
      // Append fail event so the execution is rebuildable from the file-level event log.
      try { appendEvent(vault, sessionId, { type: "fail", reason: "operator-stopped", at: stopNow }); } catch { /* never fail stop */ }
    }

    // Drain-owned Runs are headless (runTurn), not tmux — keep the VOS-187 tree-kill for the in-flight child.
    const pp = pidPath(vault, sessionId);
    if (existsSync(pp)) {
      const pid = parseInt(readFileSync(pp, "utf8"), 10);
      if (Number.isFinite(pid)) await killProcessTree(pid);
      try { rmSync(pp); } catch { /* ignore */ }
    }

    // Clean terminal view: clear the stale error banner.
    try { rmSync(errorPath(vault, sessionId)); } catch { /* none */ }

    // Halt the drain if this session belongs to one; read skill name for stopped body.
    let skill = "";
    const metaPath = join(sessionDir(vault, sessionId), "session-meta.json");
    if (existsSync(metaPath)) {
      try {
        const m = JSON.parse(readFileSync(metaPath, "utf8")) as { skill?: string; drainIssue?: number; worktree?: string };
        skill = m.skill ?? "";
        if (typeof m.drainIssue === "number" && m.worktree) {
          writeFileSync(join(m.worktree, "drain.stop"), "1");
        }
      } catch { /* ignore malformed meta */ }
    }
    // Write a clean stopped body so re-open shows true terminal state (not placeholder spinner).
    // Advancing mtime also triggers the SSE reload → spinner replaced with stopped view.
    writeFileSync(bodyPath(vault, sessionId), stoppedBody(skill));
    return c.redirect("/");
  });

  // POST /s/:uuid/attach-here — retarget the operator's `void-os attach` terminal to this session.
  // If the session's tmux is not live (reaped), respawn it via --resume first.
  // This is the "web button → operator's terminal snaps to live chat" path (VOS-205 step 2/3).
  // VOS-219: when no tmux client is attached, return the start command rather than a silent no-op.
  app.post("/s/:uuid/attach-here", async (c) => {
    const uuid = c.req.param("uuid");
    const target = `vos-run-${uuid}`;
    // Detect whether a local tmux client is attached to the -L vos socket.
    // When no client is attached, switch-client is a silent no-op; surface the start command instead.
    if (!hasAttachedClient()) {
      return c.json({ attached: false, command: attachInvocation() });
    }
    const cfg = readConfig(vault);
    const daemonUrl = `http://127.0.0.1:${cfg.port}`;
    const runnerCommand = resolveRunner(cfg);
    // Respawn if reaped (idempotent — if still live, respawnSession returns immediately).
    if (!hasSession(target)) {
      respawnSession(db, vault, uuid, runnerCommand, daemonUrl);
    }
    const r = switchClient(target);
    return c.json({ attached: true, ok: r.code === 0, target, err: r.stderr || undefined });
  });

  // GET /s/:uuid/attach-state — returns { attached: bool, command: string } for initial render (VOS-219).
  app.get("/s/:uuid/attach-state", (c) => {
    return c.json({ attached: hasAttachedClient(), command: attachInvocation() });
  });

  // POST /s/:uuid/message — ONE model for chat input: live → send-keys; reaped → respawn(--resume) then send-keys.
  // Reconciliation note: this route serves INTERACTIVE sessions only. The existing POST /s/:uuid/send
  // (headless form-render via fresh spawnRun) is UNTOUCHED and continues serving form-render sessions.
  // The two coexist, keyed on session-kind (session-meta.interactive===true vs. form-render).
  app.post("/s/:uuid/message", async (c) => {
    const uuid = c.req.param("uuid");
    const body = await c.req.parseBody();
    const text = String(body.text ?? "").trim();
    if (!text) return c.json({ ok: false, err: "empty" }, 400);
    const target = `vos-run-${uuid}`;
    const cfg = readConfig(vault);
    const daemonUrl = `http://127.0.0.1:${cfg.port}`;
    const runnerCommand = resolveRunner(cfg);
    // Respawn if reaped.
    const wasReaped = !hasSession(target);
    if (wasReaped) {
      respawnSession(db, vault, uuid, runnerCommand, daemonUrl);
    }
    // Touch last-activity stamp so the reaper resets the idle clock (file-stamp source in reaper.ts).
    try {
      const dir = sessionDir(vault, uuid);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "last-activity.txt"), String(Date.now()));
    } catch { /* non-fatal */ }
    // VOS-222: after a respawn the REPL needs ~15-20s to reach input-ready state.
    // Plain sendKeys fired immediately silently drops the keystroke.
    // Use sendAfterRespawn (waitForReady + retry-until-accepted) on the respawn path.
    if (wasReaped) {
      void sendAfterRespawn(target, text);
    } else {
      sendKeys(target, text);
    }
    return c.json({ ok: true, target });
  });

  // GET /s/:uuid/status — plain-text SessionStatus for the SSE client to decide when to stop reloading.
  // Uses the shared statusFor() so SSE poll always agrees with the dashboard dot (VOS-208).
  app.get("/s/:uuid/status", (c) => {
    const uuid = c.req.param("uuid");
    const bp = bodyPath(vault, uuid);
    const html = existsSync(bp) ? readFileSync(bp, "utf8") : "";
    return c.text(statusFor(vault, uuid, html, db));
  });

  // POST /s/:uuid/send — answer-back: serialize ALL form fields as "key: value\n" lines, resume session
  app.post("/s/:uuid/send", async (c) => {
    const uuid = c.req.param("uuid");
    const body = await c.req.parseBody();
    // Bug #1 fix: serialize ALL submitted form fields, not just body.text
    // Each field becomes "key: value\n" so the onboarding skill (and others) can read name + checkboxes
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      fields[k] = String(v);
    }
    const text = Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    // Recover the runner command stored at launch time; fall back to vault default
    const metaPath = join(sessionDir(vault, uuid), "session-meta.json");
    let runnerCommand = resolveRunner(readConfig(vault)); // default fallback for legacy sessions
    let meta: { runner?: string; drainIssue?: number; worktree?: string; max?: number; skill?: string; parkedBoxRaw?: string; interactive?: boolean } = {};
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
        if (typeof meta.runner === "string" && meta.runner) runnerCommand = meta.runner;
      } catch { /* keep default */ }
    }

    // Drain-session resume: if this session was parked by a drain (human gate verdict),
    // resume the skill IN THE WORKTREE (so its edits land in the repo), then re-invoke drain()
    // (verdict-aware path A: continuation passes the accepted human box so runner checks it).
    // NOTE: drain guard must stay BEFORE the VOS-206 interactive branch so drain sessions
    // with interactive:true still take the worktree-resume path, not send-keys.
    if (typeof meta.drainIssue === "number" && meta.worktree) {
      // Resume the parked skill in the worktree so its edits land in the repo
      const ccSessionIdDrain = readCcSessionId(vault, uuid);
      await runTurn(meta.worktree, vault, uuid, buildAnswerArgv(uuid, text, ccSessionIdDrain), runnerCommand);
      // Re-invoke the drain loop (async, fire-and-forget); idempotent drain skips checked boxes.
      // Verdict-aware path A: pass the parked box raw so the continuation checks it without re-spawning.
      // We read the current Issue body to find which box is parked (the human box that just got a verdict).
      // For simplicity: since the parked session's meta doesn't store the specific box raw,
      // we rely on the drain loop: re-invoke with acceptHumanBox from meta if stored, else just drain.
      // Verdict-aware path A: if the verdict is "accept" and we know the parked box raw,
      // pass acceptHumanBox so the continuation runner checks that box directly (no re-spawn).
      // The dirty-worktree guard is skipped on iteration 1 of acceptHumanBox continuations
      // (the skill left a dirty tree — its reviewable changes — which the runner now commits).
      const acceptHumanBox = text.includes("verdict: accept") && meta.parkedBoxRaw
        ? meta.parkedBoxRaw : undefined;
      // Clear body.html <form> after verdict so the session exits the agent-inbox
      if (acceptHumanBox) {
        writeFileSync(bodyPath(vault, uuid), "<p>Verdict accepted — drain continuing.</p>");
      } else {
        // Write working-page into body.html so the iframe shows it while the skill runs.
        // Redirect to the shell (/s/:uuid) keeps back-nav and Stop control visible.
        writeFileSync(bodyPath(vault, uuid), workingPage(fields));
      }
      setTimeout(() => {
        const drainOpts = buildDrainOptsFor(vault, meta.drainIssue!, meta.worktree!, runnerCommand, meta.max ?? 12);
        void drain({ ...drainOpts, acceptHumanBox });
      }, 500);
      return c.redirect(`/s/${uuid}`);
    }

    // VOS-211: UNIFIED send path. ANY non-drain session — interactive REPL OR a finished
    // interactive:false worker (skill-author, deep-research) — resumes its OWN thread:
    // respawn-if-reaped (respawnSession → vc --raw -- --resume <ccId>), then send-keys.
    // The previous fall-through spawned a fresh spawnRun (a SUCCESSOR exec), abandoning the
    // original thread — deleted. A worker that never wrote cc-actual cannot resume; respawnSession
    // returns null and the live send still no-ops gracefully (sendKeys to a dead pane is harmless).
    const target = `vos-run-${uuid}`;
    const cfg = readConfig(vault);
    const daemonUrl = `http://127.0.0.1:${cfg.port}`;
    const wasReapedSend = !hasSession(target);
    if (wasReapedSend) {
      respawnSession(db, vault, uuid, runnerCommand, daemonUrl);
    }
    try {
      const dir = sessionDir(vault, uuid);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "last-activity.txt"), String(Date.now()));
    } catch { /* non-fatal */ }
    // VOS-222: after a respawn the REPL needs ~15-20s to reach input-ready state.
    // Plain sendKeys fired immediately silently drops the keystroke.
    // Use sendAfterRespawn (waitForReady + retry-until-accepted) on the respawn path.
    if (wasReapedSend) {
      void sendAfterRespawn(target, text);
    } else {
      sendKeys(target, text);
    }
    // Replace the form so the session leaves the awaiting/agent-inbox state (stranded-yellow dissolves).
    writeFileSync(bodyPath(vault, uuid), workingPage(fields));
    return c.redirect(`/s/${uuid}`);
  });

  // Session-id shape guard (VOS-211): reject anything that could escape sessionDir (path traversal).
  // void-os run ids are "exec-" + a uuid; allow that plus bare ids (legacy/tests). No "..".
  const isValidSessionId = (id: string): boolean =>
    /^[A-Za-z0-9_-]{1,128}$/.test(id) && !id.includes("..");

  // POST /s/:uuid/act — htmx hypermedia loop (VOS-211). The agent's body.html posts a form here.
  // Ack-FAST: serialize the form fields → route through the SAME unified send path as POST /send
  // (respawn-if-reaped → send-keys into the session's OWN thread), write a workingPage so the
  // existing SSE reload (GET /stream) re-renders the panel when the agent writes a fresh body.html.
  // Returns an ack FRAGMENT synchronously — never blocks on the agent turn. The submission becomes a
  // visible transcript turn automatically: send-keys hits the live CC REPL, CC records it in its JSONL,
  // and GET /s/:uuid/transcript already renders that JSONL — no separate append.
  // Two-verb (VOS-211 deferred): only the message verb ships; a future `verb` field can branch.
  // CORS: daemon is tailnet-only; allow-origin:* lets the sandboxed iframe (null origin) POST back.
  app.options("/s/:uuid/act", (c) =>
    new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "content-type, hx-request, hx-target, hx-current-url, hx-trigger, hx-trigger-name, hx-boosted, hx-history-restore-request",
    } }));
  app.post("/s/:uuid/act", async (c) => {
    const uuid = c.req.param("uuid");
    if (!isValidSessionId(uuid)) return c.text("bad session id", 400);
    const body = await c.req.parseBody();
    // Serialize ALL fields as "key: value\n" (mirrors POST /send so a multi-field form arrives intact).
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) fields[k] = String(v);
    const text = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
    if (!text) return c.html(ackFragment(), 400);

    // Recover the per-session runner (mirrors /send): session-meta.runner or vault default.
    const metaPath = join(sessionDir(vault, uuid), "session-meta.json");
    let runnerCommand = resolveRunner(readConfig(vault));
    if (existsSync(metaPath)) {
      try {
        const m = JSON.parse(readFileSync(metaPath, "utf8")) as { runner?: string };
        if (typeof m.runner === "string" && m.runner) runnerCommand = m.runner;
      } catch { /* keep default */ }
    }
    const target = `vos-run-${uuid}`;
    const cfg = readConfig(vault);
    const daemonUrl = `http://127.0.0.1:${cfg.port}`;
    const wasReapedAct = !hasSession(target);
    if (wasReapedAct) {
      respawnSession(db, vault, uuid, runnerCommand, daemonUrl);
    }
    try {
      const dir = sessionDir(vault, uuid);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "last-activity.txt"), String(Date.now()));
    } catch { /* non-fatal */ }
    // VOS-222: after a respawn the REPL needs ~15-20s to reach input-ready state.
    // Plain sendKeys fired immediately silently drops the keystroke.
    // Use sendAfterRespawn (waitForReady + retry-until-accepted) on the respawn path.
    if (wasReapedAct) {
      void sendAfterRespawn(target, text);
    } else {
      sendKeys(target, text);
    }
    // Advance body.html → SSE reload swaps the iframe to the working page until the agent rewrites it.
    writeFileSync(bodyPath(vault, uuid), workingPage(fields));
    // CORS header for null-origin sandboxed iframe.
    return new Response(ackFragment(), {
      headers: { "content-type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  });

  // POST /triggers/:name/fire — manually fire a named Trigger, spawning a real Run.
  // ?interactive=1 forces non-print (interactive tmux) mode — needed when Stop hooks must fire.
  // Returns { runId } on success, 404 if trigger not found or disabled.
  app.post("/triggers/:name/fire", async (c) => {
    const name = c.req.param("name");
    if (!spawnFn) return c.json({ error: "no spawn function configured" }, 503);
    const interactive = c.req.query("interactive") === "1";
    const forcePrint = interactive ? false : null; // null = default (print for trigger-fired)
    // Accept optional input + inputRef from request body (e.g. chat trigger fire with thread file).
    let bodyInput: string | null = null;
    let bodyInputRef: string | null = null;
    try {
      const b = await c.req.json() as Record<string, unknown>;
      if (typeof b.input === "string") bodyInput = b.input;
      if (typeof b.inputRef === "string") bodyInputRef = b.inputRef;
    } catch { /* no body or non-JSON body — fine */ }
    const res = fireTrigger(db, name, { spawn: spawnFn, now: Date.now(), input: bodyInput, inputRef: bodyInputRef, forcePrint });
    if (!res) return c.json({ error: "no such trigger or disabled" }, 404);
    return c.json({ runId: res.runId });
  });

  // ---------------------------------------------------------------------------
  // Skill-manage HTTP routes (VOS-199) — thin wrapper for MCP server daemon-mode.
  // ---------------------------------------------------------------------------

  // GET /skill-manage/skills_list — list installed vault skills
  app.get("/skill-manage/skills_list", (c) => {
    return c.json(listVaultSkills(vault));
  });

  // POST /skill-manage/skills_list — also accept POST for symmetry with MCP daemon mode
  app.post("/skill-manage/skills_list", (c) => {
    return c.json(listVaultSkills(vault));
  });

  // POST /skill-manage/skill_view — return SKILL.md body
  app.post("/skill-manage/skill_view", async (c) => {
    const b = await c.req.json() as Record<string, unknown>;
    const name = String(b.name ?? "");
    if (!name) return c.json({ error: "name required" }, 400);
    const body = viewVaultSkill(vault, name);
    if (!body) return c.json({ error: `skill not found: ${name}` }, 404);
    return c.json({ name, body });
  });

  // POST /skill-manage/mutate — gate a skill mutation (all actions)
  // Returns { txnId, decisionId, status: "parked" }
  app.post("/skill-manage/mutate", async (c) => {
    const b = await c.req.json() as Record<string, unknown>;
    const action = String(b.action ?? "");
    const name = String(b.name ?? "");
    const execId = String(b.exec_id ?? `daemon-${randomUUID()}`);

    if (!action || !name) return c.json({ error: "action and name required" }, 400);

    try {
      let result: { txnId: string; decisionId: string; status: string };

      if (action === "create") {
        const body = String(b.body ?? "");
        if (!body) return c.json({ error: "body required for create" }, 400);
        result = gateCreate(vault, {
          execId, name, body,
          trigger: b.trigger ? String(b.trigger) : undefined,
        });
      } else if (action === "patch") {
        const oldBody = String(b.old_body ?? "");
        const newBody = String(b.body ?? "");
        if (!oldBody || !newBody) return c.json({ error: "old_body and body required for patch" }, 400);
        result = gatePatch(vault, {
          execId, name, oldBody, newBody,
          trigger: b.trigger ? String(b.trigger) : undefined,
        });
      } else if (action === "edit") {
        const body = String(b.body ?? "");
        if (!body) return c.json({ error: "body required for edit" }, 400);
        result = gateEdit(vault, {
          execId, name, body,
          trigger: b.trigger ? String(b.trigger) : undefined,
        });
      } else if (action === "delete") {
        result = gateDelete(vault, { execId, name });
      } else if (action === "write_file") {
        const filePath = String(b.file_path ?? "");
        const content = String(b.content ?? "");
        if (!filePath || !content) return c.json({ error: "file_path and content required for write_file" }, 400);
        result = gateWriteFile(vault, { execId, name, filePath, content });
      } else {
        return c.json({ error: `unknown action: ${action}` }, 400);
      }

      return c.json(result);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // GET /s/:uuid/stream — SSE: emits "reload" whenever body.html mtime advances.
  // Sends a keepalive ping comment every PING_INTERVAL_MS so the connection never
  // idles out — even Bun's idleTimeout:255 is not enough for very slow cold starts.
  const PING_INTERVAL_MS = 5_000;
  app.get("/s/:uuid/stream", (c) => {
    const uuid = c.req.param("uuid");
    const bp = bodyPath(vault, uuid);
    let last = existsSync(bp) ? statSync(bp).mtimeMs : 0;
    let msSinceLastPing = 0;
    return streamSSE(c, async (stream) => {
      while (!stream.closed) {
        const now = existsSync(bp) ? statSync(bp).mtimeMs : 0;
        if (now > last) {
          last = now;
          msSinceLastPing = 0;
          await stream.writeSSE({ data: "reload" });
        } else {
          msSinceLastPing += 1000;
          if (msSinceLastPing >= PING_INTERVAL_MS) {
            msSinceLastPing = 0;
            // SSE comment keeps the socket alive without triggering onmessage.
            // Two newlines (\n\n) terminate the SSE event block per the protocol.
            await stream.write(": ping\n\n");
          }
        }
        await stream.sleep(1000);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // VOS-225 §2 — daemon-hosted SHARED MCP transport. ONE instance for all sessions.
  // Stateless streamable-HTTP (JSON responses): every spawned CC session reaches the four
  // vault tools (vault.write/append, page.register/list) at this URL via its generated .mcp.json.
  // ---------------------------------------------------------------------------
  // Stateless mode: a fresh transport (and server) PER REQUEST — the SDK forbids reusing a
  // stateless transport across requests (id-collision guard). The tools themselves are stateless
  // (all state is files: the vault + manifest), so per-request instantiation is correct + cheap.
  // page.register serialization lives in vault-mcp.ts (module-level mutex), so it survives the
  // per-request server churn — concurrent registers still serialize on the single daemon process.
  app.all("/mcp", async (c) => {
    const server = createVaultMcpServer(vault);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,      // JSON request/response (no long-lived SSE per call)
    });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    c.req.raw.signal?.addEventListener("abort", () => { void server.close(); });
    return res;
  });

  // ---------------------------------------------------------------------------
  // VOS-225 §3.3 — live pages. GET /p/:slug renders a manifest-registered panel inside a
  // shell mirroring /s/:uuid; the panel is a READ-ONLY LIVE VIEW that reloads when its
  // declared data-vos-source glob changes (§3.4). POST /p/:slug/act is the v1.5 410 seam.
  // ---------------------------------------------------------------------------
  const slugOf = (c: { req: { param: (k: string) => string } }) => c.req.param("slug");
  const lookupPage = (slug: string) => readManifest(vault).pages.find((p) => p.slug === slug);

  // GET /p/:slug — shell wrapping the panel body + an SSE stream keyed on the data source.
  app.get("/p/:slug", (c) => {
    const slug = slugOf(c);
    const page = lookupPage(slug);
    if (!page) return c.text("no such page", 404);
    // VOS-228 §3.3: serve the page inside a navigable shell (leftNav + iframe + data-source SSE).
    return c.html(renderPageShell(slug, listSessions(vault, db), readManifest(vault).pages));
  });

  // GET /p/:slug/body — the panel html through the shared pipeline; missing-file → stub (never 500).
  app.get("/p/:slug/body", (c) => {
    const slug = slugOf(c);
    const page = lookupPage(slug);
    if (!page) return c.text("no such page", 404);
    const abs = join(vault, page.path);
    if (!existsSync(abs)) {
      return c.html(renderPanelBody(`<p>page file missing: ${page.path}</p>`, slug));
    }
    const raw = readFileSync(abs, "utf8");
    // VOS-228 §2 live-data seam: replace any example cards with REAL task cards parsed from the
    // panel's data-vos-source glob (no-op for non-board panels). The SSE reload re-fetches this
    // route, so editing a task file regenerates the board live (§3.4).
    const withData = renderBoardData(vault, raw);
    return c.html(renderPanelBody(withData, slug));
  });

  // GET /p/:slug/stream — SSE: emit "reload" when the page's data-source glob mtime advances.
  // Freshness watches the DATA SOURCE (e.g. work/tasks/active/*.md), not the served html (§3.4).
  app.get("/p/:slug/stream", (c) => {
    const slug = slugOf(c);
    const page = lookupPage(slug);
    if (!page) return c.text("no such page", 404);
    const abs = join(vault, page.path);
    // resolve the data-source glob from the panel html; fall back to watching the html file itself.
    let glob: string | null = null;
    if (existsSync(abs)) { try { glob = extractDataSource(readFileSync(abs, "utf8")); } catch { /* none */ } }
    const mtimeNow = () => {
      const data = glob ? dataSourceMtime(vault, glob) : 0;
      const self = existsSync(abs) ? statSync(abs).mtimeMs : 0;
      return Math.max(data, self); // also reload if the panel html itself is re-authored
    };
    let last = mtimeNow();
    let msSinceLastPing = 0;
    const PING_INTERVAL_MS = 5_000;
    return streamSSE(c, async (stream) => {
      while (!stream.closed) {
        const now = mtimeNow();
        if (now > last) {
          last = now;
          msSinceLastPing = 0;
          await stream.writeSSE({ data: "reload" });
        } else {
          msSinceLastPing += 1000;
          if (msSinceLastPing >= PING_INTERVAL_MS) { msSinceLastPing = 0; await stream.write(": ping\n\n"); }
        }
        await stream.sleep(1000);
      }
    });
  });

  // POST /p/:slug/act — frozen 410 seam (§6.3). v1 pages are read-only live views; browser
  // write-back is v1.5. Scaffolds POST here so they ship complete, but the path is a dead-end.
  app.post("/p/:slug/act", (c) =>
    new Response("agent-mediated write-back is v1.5", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    }));
  app.options("/p/:slug/act", () =>
    new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "content-type, hx-request, hx-target, hx-current-url, hx-trigger",
    } }));

  return app;
}
