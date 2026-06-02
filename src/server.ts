// server.ts — Hono app with all routes (Task 10)
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { listCatalogSkills } from "./catalog.ts";
import { listSessions } from "./sessions.ts";
import { buildLaunchArgv, buildAnswerArgv, spawnTurn, spawnRun, runTurn } from "./spawn.ts";
import { buildAgentLaunch, type AgentLaunch } from "./agents.ts";
import { drain, type DrainOpts } from "./drain.ts";
import { renderDashboard, renderShell, placeholderBody, workingPage, stoppedBody } from "./render.ts";
import { killProcessTree } from "./kill.ts";
import { sessionDir, bodyPath, errorPath, readConfig, resolveRunner, pidPath, stopPath } from "./paths.ts";
import { homedir } from "node:os";
import { realDeps } from "./preflight.ts";
import { parseTranscript, locateTranscript, renderTranscript } from "./transcript.ts";
import { handleHookEvent, runIdForSession, type HookPayload, type HookDecision } from "./hooks-endpoint.ts";
import { getExecution, setExecutionFail, upsertTrigger, getTrigger } from "./registry.ts";
import { appendEvent } from "./events.ts";
import { killSession } from "./tmux.ts";
import { fireTrigger, type SpawnFn } from "./triggers-fire.ts";
import { listPendingDecisions } from "./decision.ts";
import {
  gateCreate, gatePatch, gateEdit, gateDelete, gateWriteFile,
  listVaultSkills, viewVaultSkill,
} from "./skill-manage.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = join(repoRoot, "catalog");

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
      renderDashboard(listCatalogSkills(catalogRoot), listSessions(vault, db), { authed: status.ok }, cfg, listPendingDecisions(vault)),
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
    const { runId, tmuxSession } = spawnRun({
      db, vault, daemonUrl, skill: skill || null, agent: agentName,
      runnerCommand, now: Date.now(), outputTarget,
      // forcePrint: agent launches use print mode so Stop hook fires for write-back (VOS-191)
      forcePrint: agentLaunch ? true : null,
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
      JSON.stringify({ skill: skill || null, agent: agentName, launchedAt: Date.now(), text, tmuxSession, runner: runnerCommand }),
    );
    writeFileSync(bodyPath(vault, runId), placeholderBody(skill));
    return c.redirect(`/s/${runId}`);
  });

  // GET /s/:uuid — iframe shell wrapping the session body
  app.get("/s/:uuid", (c) => {
    const uuid = c.req.param("uuid");
    // Read skill name from session-meta.json to show a human-readable title in the header.
    const metaPath = join(sessionDir(vault, uuid), "session-meta.json");
    let sessionName: string | undefined;
    if (existsSync(metaPath)) {
      try {
        const m = JSON.parse(readFileSync(metaPath, "utf8")) as { skill?: string; text?: string };
        if (m.skill) sessionName = m.text ? `${m.skill} — ${m.text.slice(0, 40)}` : m.skill;
      } catch { /* use fallback */ }
    }
    // Look up the execution's attach command from the registry (for the shell to display).
    const exec = getExecution(db, uuid);
    const attachCmd = exec ? `tmux attach -t ${exec.tmux_session}` : undefined;
    return c.html(renderShell(uuid, vault, sessionName, attachCmd));
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
  app.get("/s/:uuid/transcript", (c) => {
    const path = locateTranscript(c.req.param("uuid"));
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

  // GET /s/:uuid/status — plain-text SessionStatus for the SSE client to decide when to stop reloading.
  app.get("/s/:uuid/status", (c) => {
    const uuid = c.req.param("uuid");
    if (existsSync(stopPath(vault, uuid))) return c.text("stopped");
    if (existsSync(errorPath(vault, uuid))) return c.text("error");
    const bp = bodyPath(vault, uuid);
    const html = existsSync(bp) ? readFileSync(bp, "utf8") : "";
    return c.text(html.includes("<form") ? "awaiting" : "complete");
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
    let meta: { runner?: string; drainIssue?: number; worktree?: string; max?: number; skill?: string; parkedBoxRaw?: string } = {};
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
        if (typeof meta.runner === "string" && meta.runner) runnerCommand = meta.runner;
      } catch { /* keep default */ }
    }

    // Drain-session resume: if this session was parked by a drain (human gate verdict),
    // resume the skill IN THE WORKTREE (so its edits land in the repo), then re-invoke drain()
    // (verdict-aware path A: continuation passes the accepted human box so runner checks it).
    if (typeof meta.drainIssue === "number" && meta.worktree) {
      // Resume the parked skill in the worktree so its edits land in the repo
      await runTurn(meta.worktree, vault, uuid, buildAnswerArgv(uuid, text), runnerCommand);
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

    spawnTurn(vault, uuid, buildAnswerArgv(uuid, text), runnerCommand);
    // Write working-page into body.html so the iframe shows "received — working…"
    // while the skill runs, then redirect to the shell so the wrapper (back-nav +
    // Stop control) stays visible — avoids landing bare on /s/:uuid/send.
    writeFileSync(bodyPath(vault, uuid), workingPage(fields));
    return c.redirect(`/s/${uuid}`);
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

  return app;
}
