// VOS-214 Phase 4 — S6 fixture harness — run under BUN.
// Seeds a test vault with one real-body session so that iframe#f renders in the shell.
// Mounts makeApp, serves on a free port. Prints "READY http://127.0.0.1:<port>" once listening.
// Render-only: no live vc/claude/tmux. NEVER opens the operator's browser.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";

const VAULT = join(tmpdir(), "vos214-s6f-e2e-vault");
// Session id exported so the spec can build routes
export const HTMX_SESSION = "htmx-sess-s6f0001";

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({ port: 4317 }));

// Seed one session with a real body.html containing an hx-post form — this
// ensures iframe#f is rendered (hasBody=true) and sandbox attr is present.
const sessions = join(VAULT, "sessions");
const sessionDir = join(sessions, HTMX_SESSION);
mkdirSync(sessionDir, { recursive: true });
writeFileSync(
  join(sessionDir, "body.html"),
  [
    "<!doctype html><html><head><title>S6 Test Form</title></head><body>",
    `<form hx-post="/s/${HTMX_SESSION}/act">`,
    `  <input name="choice" value="ship">`,
    `  <button type="submit">Submit</button>`,
    `</form>`,
    "</body></html>",
  ].join("\n"),
);
writeFileSync(
  join(sessionDir, "session-meta.json"),
  JSON.stringify({ skill: "htmx-form-demo", interactive: true }),
);

const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const app = makeApp(VAULT, db);
const server = Bun.serve({ port: 0, fetch: app.fetch });
// Export session id for the spec (process.env lookup)
process.env.VOS214_S6F_SESSION = HTMX_SESSION;
console.log(`SESSION=${HTMX_SESSION}`);
console.log(`READY http://127.0.0.1:${server.port}`);
