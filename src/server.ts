// server.ts — Hono app with all routes (Task 10)
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { listCatalogSkills } from "./catalog.ts";
import { listSessions } from "./sessions.ts";
import { buildLaunchArgv, buildAnswerArgv, spawnTurn, runTurn } from "./spawn.ts";
import { drain, type DrainOpts } from "./drain.ts";
import { renderDashboard, renderShell, placeholderBody, workingPage } from "./render.ts";
import { sessionDir, bodyPath, errorPath, readConfig, resolveRunner } from "./paths.ts";
import { homedir } from "node:os";
import { realDeps } from "./preflight.ts";
import { parseTranscript, locateTranscript, renderTranscript } from "./transcript.ts";

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

export function makeApp(vault: string) {
  const app = new Hono();

  // GET / — dashboard: skill buttons + session list + relay status banner
  app.get("/", async (c) => {
    const status = await realDeps.vcStatus();
    const cfg = readConfig(vault);
    return c.html(
      renderDashboard(listCatalogSkills(catalogRoot), listSessions(vault), { authed: status.ok }, cfg),
    );
  });

  // POST /launch — relay auth guard, create session dir, write placeholder, fire spawnTurn, redirect
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
    const runnerCommand = resolveRunner(readConfig(vault), runnerLabel || undefined);
    const uuid = randomUUID();
    const dir = sessionDir(vault, uuid);
    mkdirSync(dir, { recursive: true });
    // Write session metadata for title fallback + status display
    writeFileSync(
      join(dir, "session-meta.json"),
      JSON.stringify({ skill, launchedAt: Date.now(), text, runner: runnerCommand }),
    );
    // Forge #2: write placeholder BEFORE spawning so the body route never 404s
    writeFileSync(bodyPath(vault, uuid), placeholderBody(skill));
    // F7: buildLaunchArgv already handles prompt construction
    spawnTurn(vault, uuid, buildLaunchArgv(uuid, skill, text), runnerCommand);
    return c.redirect(`/s/${uuid}`);
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
    return c.html(renderShell(uuid, vault, sessionName));
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
      html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  background:#ffffff;color:#1a1a1a;padding:1rem;line-height:1.5}
</style></head><body>${html}</body></html>`;
    }
    const ep = errorPath(vault, uuid);
    if (existsSync(ep)) {
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
      }
      setTimeout(() => {
        const drainOpts = buildDrainOptsFor(vault, meta.drainIssue!, meta.worktree!, runnerCommand, meta.max ?? 12);
        void drain({ ...drainOpts, acceptHumanBox });
      }, 500);
      return c.html(workingPage(fields));
    }

    spawnTurn(vault, uuid, buildAnswerArgv(uuid, text), runnerCommand);
    // Bug #5 fix: return working page with submitted context + elapsed timer
    return c.html(workingPage(fields));
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
