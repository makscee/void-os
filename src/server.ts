// server.ts — Hono app with all routes (Task 10)
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { listCatalogSkills } from "./catalog.ts";
import { listSessions } from "./sessions.ts";
import { buildLaunchArgv, buildAnswerArgv, spawnTurn } from "./spawn.ts";
import { renderDashboard, renderShell, placeholderBody, workingPage } from "./render.ts";
import { sessionDir, bodyPath, errorPath } from "./paths.ts";
import { realDeps } from "./preflight.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = join(repoRoot, "catalog");

export function makeApp(vault: string) {
  const app = new Hono();

  // GET / — dashboard: skill buttons + session list + relay status banner
  app.get("/", async (c) => {
    const status = await realDeps.vcStatus();
    return c.html(
      renderDashboard(listCatalogSkills(catalogRoot), listSessions(vault), { authed: status.ok }),
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
    const uuid = randomUUID();
    const dir = sessionDir(vault, uuid);
    mkdirSync(dir, { recursive: true });
    // Write session metadata for title fallback + status display
    writeFileSync(
      join(dir, "session-meta.json"),
      JSON.stringify({ skill, launchedAt: Date.now(), text }),
    );
    // Forge #2: write placeholder BEFORE spawning so the body route never 404s
    writeFileSync(bodyPath(vault, uuid), placeholderBody());
    // F7: buildLaunchArgv already handles prompt construction
    spawnTurn(vault, uuid, buildLaunchArgv(uuid, skill, text));
    return c.redirect(`/s/${uuid}`);
  });

  // GET /s/:uuid — iframe shell wrapping the session body
  app.get("/s/:uuid", (c) => c.html(renderShell(c.req.param("uuid"), vault)));

  // GET /s/:uuid/body — serves the session's body.html, appends error banner if error.txt present.
  // Exception: suppress a "timeout" error when body.html was updated AFTER error.txt was written —
  // the skill completed during SIGTERM cleanup, so the timeout was premature and the output is valid.
  app.get("/s/:uuid/body", (c) => {
    const uuid = c.req.param("uuid");
    const bp = bodyPath(vault, uuid);
    if (!existsSync(bp)) return c.text("no body yet", 404);
    let html = readFileSync(bp, "utf8");
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

  // GET /s/:uuid/body/assets/* — static assets written by the session alongside body.html
  app.get("/s/:uuid/body/assets/*", (c) => {
    const uuid = c.req.param("uuid");
    const rel = c.req.path.split("/assets/")[1];
    const p = join(sessionDir(vault, uuid), "assets", rel);
    if (!existsSync(p)) return c.text("not found", 404);
    return new Response(Bun.file(p));
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
    spawnTurn(vault, uuid, buildAnswerArgv(uuid, text));
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
