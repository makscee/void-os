// VOS-214 Phase P2 — S8 no-html/wedged-case harness — run under BUN.
// Seeds a test vault with FOUR sessions covering the full S8 matrix:
//   (a) NO_BODY     — no body.html at all (truly absent)
//   (b) same session used for t2 affordance check (reuses (a))
//   (c) PLACEHOLDER — body.html == placeholderBody (spinner + "— starting…")
//   (d) REAL_BODY   — body.html with real <h1> content
// Mounts makeApp, serves on a free port. Prints "READY http://127.0.0.1:<port>" once listening.
// Render-only: no live vc/claude/tmux. NEVER opens a browser.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { placeholderBody } from "../src/render.ts";

const VAULT = join(tmpdir(), "vos214-s8-e2e-vault");
export const NO_BODY = "s8-no-body-0000-0000-0000-000000000000";
export const PLACEHOLDER = "s8-placeholder-0000-0000-0000-00000000";
export const REAL_BODY = "s8-real-body-0000-0000-0000-000000000";
const CC_ID = "12345678-1234-4678-89ab-cdef01234567";

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({ port: 4317 }));

const sessions = join(VAULT, "sessions");

// (a)+(b): NO body.html — the "wedged" empty session
const aDir = join(sessions, NO_BODY);
mkdirSync(aDir, { recursive: true });
// Deliberately do NOT write body.html — the session has no output at all
writeFileSync(join(aDir, "cc-actual-session.txt"), CC_ID);
writeFileSync(join(aDir, "session-meta.json"), JSON.stringify({ skill: "skill-author", interactive: false }));

// (c): placeholder body — spinner + "— starting…" title
const cDir = join(sessions, PLACEHOLDER);
mkdirSync(cDir, { recursive: true });
writeFileSync(join(cDir, "body.html"), placeholderBody("skill-author"));
writeFileSync(join(cDir, "session-meta.json"), JSON.stringify({ skill: "skill-author", interactive: false }));

// (d): real body — skill actually wrote real HTML content
const dDir = join(sessions, REAL_BODY);
mkdirSync(dDir, { recursive: true });
writeFileSync(
  join(dDir, "body.html"),
  "<!doctype html><html><head><title>Results</title></head><body><h1>Agent Output</h1><p>real agent content here</p></body></html>",
);
writeFileSync(join(dDir, "session-meta.json"), JSON.stringify({ skill: "deep-research", interactive: false }));

const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const app = makeApp(VAULT, db);
const server = Bun.serve({ port: 0, fetch: app.fetch });
console.log(`READY http://127.0.0.1:${server.port}`);
