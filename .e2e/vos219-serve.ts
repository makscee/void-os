// VOS-219 finalizer render-gate harness — run under BUN.
// Seeds a test vault with: (a) a session with body.html, (b) a session without body.html,
// (c) a mixed sidebar: needs-you + idle + recent sessions.
// Prints "READY <baseUrl>" once listening. Render-only: no live vc/claude/tmux.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { placeholderBody } from "../src/render.ts";

const VAULT = join(tmpdir(), "vos219-e2e-vault");
const WITH_BODY = "with-body-sess-0001";
const NO_BODY_SESS = "no-body-sess-0002";
const NEEDS_YOU = "needs-you-sess-0003";
const IDLE_SESS = "idle-sess-0004";
const CC_ID = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({ port: 4317 }));

const sessions = join(VAULT, "sessions");

// Session WITH body.html (real content)
const a = join(sessions, WITH_BODY);
mkdirSync(a, { recursive: true });
writeFileSync(
  join(a, "body.html"),
  "<!doctype html><html><head><title>skill-x — results</title></head><body><h1>Body content here</h1></body></html>",
);
writeFileSync(join(a, "cc-actual-session.txt"), CC_ID);
writeFileSync(join(a, "session-meta.json"), JSON.stringify({ skill: "skill-x", interactive: false }));

// Session WITHOUT real body (placeholder spinner) — bodyHasRealContent returns false for this
const b = join(sessions, NO_BODY_SESS);
mkdirSync(b, { recursive: true });
writeFileSync(join(b, "body.html"), placeholderBody("skill-y")); // real placeholderBody has spinner → no real content
writeFileSync(join(b, "session-meta.json"), JSON.stringify({ skill: "skill-y", interactive: false }));

// Needs-you session (has a form)
const c = join(sessions, NEEDS_YOU);
mkdirSync(c, { recursive: true });
writeFileSync(join(c, "body.html"), `<!doctype html><html><head><title>decision</title></head><body><form action='/send'><input name='answer'><button>Submit</button></form></body></html>`);
writeFileSync(join(c, "session-meta.json"), JSON.stringify({ skill: "decision", interactive: false }));

// Idle session (working but stale — stopped.txt absent, no exec row = complete)
const d = join(sessions, IDLE_SESS);
mkdirSync(d, { recursive: true });
writeFileSync(join(d, "body.html"), `<!doctype html><html><head><title>idle research</title></head><body><p>done</p></body></html>`);
writeFileSync(join(d, "session-meta.json"), JSON.stringify({ skill: "deep-research", interactive: false }));

const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const app = makeApp(VAULT, db);
const server = Bun.serve({ port: 0, fetch: app.fetch });
process.env.VOS219_WITH_BODY = WITH_BODY;
process.env.VOS219_NO_BODY = NO_BODY_SESS;
console.log(`READY http://127.0.0.1:${server.port}`);
