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

  // POST /launch — create session dir, write placeholder, fire spawnTurn, redirect
  app.post("/launch", async (c) => {
    const body = await c.req.parseBody();
    const skill = String(body.skill ?? "");
    const text = String(body.text ?? "");
    const uuid = randomUUID();
    mkdirSync(sessionDir(vault, uuid), { recursive: true });
    // Forge #2: write placeholder BEFORE spawning so the body route never 404s
    writeFileSync(bodyPath(vault, uuid), placeholderBody());
    // F7: buildLaunchArgv already handles prompt construction
    spawnTurn(vault, uuid, buildLaunchArgv(uuid, skill, text));
    return c.redirect(`/s/${uuid}`);
  });

  // GET /s/:uuid — iframe shell wrapping the session body
  app.get("/s/:uuid", (c) => c.html(renderShell(c.req.param("uuid"))));

  // GET /s/:uuid/body — serves the session's body.html, appends error banner if error.txt present
  app.get("/s/:uuid/body", (c) => {
    const uuid = c.req.param("uuid");
    const bp = bodyPath(vault, uuid);
    if (!existsSync(bp)) return c.text("no body yet", 404);
    let html = readFileSync(bp, "utf8");
    if (existsSync(errorPath(vault, uuid))) {
      html += `<pre style="color:#a00;border-top:1px solid #a00;padding:1rem">${
        readFileSync(errorPath(vault, uuid), "utf8")
      }</pre>`;
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

  // POST /s/:uuid/send — answer-back: build prompt from form fields, resume session
  app.post("/s/:uuid/send", async (c) => {
    const uuid = c.req.param("uuid");
    const body = await c.req.parseBody();
    // F7: form fields are formatted as key: value lines by the caller;
    // buildAnswerArgv prepends the render-contract preamble
    const text = String(body.text ?? "");
    spawnTurn(vault, uuid, buildAnswerArgv(uuid, text));
    return c.html(workingPage());
  });

  // GET /s/:uuid/stream — SSE: emits "reload" whenever body.html mtime advances
  app.get("/s/:uuid/stream", (c) => {
    const uuid = c.req.param("uuid");
    const bp = bodyPath(vault, uuid);
    let last = existsSync(bp) ? statSync(bp).mtimeMs : 0;
    return streamSSE(c, async (stream) => {
      while (!stream.closed) {
        const now = existsSync(bp) ? statSync(bp).mtimeMs : 0;
        if (now > last) {
          last = now;
          await stream.writeSSE({ data: "reload" });
        }
        await stream.sleep(1000);
      }
    });
  });

  return app;
}
