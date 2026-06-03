// VOS-212 finalizer render-gate harness — run under BUN.
// Seeds a test vault with two sessions (placeholder body => no real content, real body => content),
// mounts makeApp, serves it on a free port. Prints "READY <baseUrl>" once listening.
// Render-only: no live vc/claude/tmux. NEVER opens the operator's browser (no --open path here).
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { placeholderBody } from "../src/render.ts";

const VAULT = join(tmpdir(), "vos212-e2e-vault");
const NO_BODY = "no-body-sess-0000";
const REAL_BODY = "real-body-sess-1111";
const CC_ID = "abcdef01-2345-4678-89ab-cdef01234567";

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({ port: 4317 }));

const sessions = join(VAULT, "sessions");
const a = join(sessions, NO_BODY);
mkdirSync(a, { recursive: true });
writeFileSync(join(a, "body.html"), placeholderBody("skill-author")); // placeholder => no real content => no iframe
writeFileSync(join(a, "cc-actual-session.txt"), CC_ID);
writeFileSync(join(a, "session-meta.json"), JSON.stringify({ skill: "skill-author", interactive: false }));

const b = join(sessions, REAL_BODY);
mkdirSync(b, { recursive: true });
writeFileSync(
  join(b, "body.html"),
  "<!doctype html><html><head><title>Results</title></head><body><h1>Deep Research Results</h1><p>real content</p></body></html>",
);
writeFileSync(join(b, "session-meta.json"), JSON.stringify({ skill: "deep-research", interactive: false }));

const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const app = makeApp(VAULT, db);
const server = Bun.serve({ port: 0, fetch: app.fetch });
console.log(`READY http://127.0.0.1:${server.port}`);
