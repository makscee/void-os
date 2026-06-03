// VOS-214 Phase-3 serve harness — S5 attach/resume-command fixture.
// Seeds 4 sessions:
//   LIVE_ID   — placeholder body, cc-actual-session.txt present (simulates live or awaiting state)
//   REAPED_ID — placeholder body, cc-actual-session.txt present, reaped.txt present
//   EXITED_ID — placeholder body, cc-actual-session.txt present, ended_at set (no reaped.txt/tmux)
//   PRECID_ID — placeholder body, NO cc-actual-session.txt (pre-ccId edge for S5·t4)
//
// No live vc/claude/tmux. Prints "READY http://127.0.0.1:<port>" when serving.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { placeholderBody } from "../src/render.ts";
import { createExecution } from "../src/registry.ts";

const VAULT = join(tmpdir(), "vos214-s5-e2e-vault");

// Session IDs — use UUID-form so isValidSessionId passes
export const LIVE_ID   = "11111111-1111-4111-a111-111111111111";
export const REAPED_ID = "22222222-2222-4222-a222-222222222222";
export const EXITED_ID = "33333333-3333-4333-a333-333333333333";
export const PRECID_ID = "44444444-4444-4444-a444-444444444444";

// The CC_ID seeded into cc-actual-session.txt for the 3 ccId-bearing sessions.
// Must match /^[0-9a-f-]{36}$/ per readCcSessionId validation.
export const CC_ID = "abcdef01-2345-4678-89ab-cdef01234567";

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({ port: 4317 }));

const sessions = join(VAULT, "sessions");

function seedSession(
  id: string,
  opts: { ccId?: string; reaped?: boolean; skill?: string },
) {
  const dir = join(sessions, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "body.html"), placeholderBody(opts.skill ?? "skill-author"));
  writeFileSync(join(dir, "session-meta.json"), JSON.stringify({ skill: opts.skill ?? "skill-author", interactive: false }));
  if (opts.ccId) {
    writeFileSync(join(dir, "cc-actual-session.txt"), opts.ccId);
  }
  if (opts.reaped) {
    writeFileSync(join(dir, "reaped.txt"), "reaped");
  }
}

// LIVE: ccId present, no reaped.txt (simulates live/working)
seedSession(LIVE_ID,   { ccId: CC_ID, skill: "smoke-test" });
// REAPED: ccId present, reaped.txt present
seedSession(REAPED_ID, { ccId: CC_ID, reaped: true, skill: "skill-author" });
// EXITED: ccId present, ended but no reaped.txt (session ended cleanly, no tmux)
seedSession(EXITED_ID, { ccId: CC_ID, skill: "deep-research" });
// PRE-CCID: NO cc-actual-session.txt (t4 edge)
seedSession(PRECID_ID, { skill: "smoke-test" });

// Insert DB rows so listSessions works in the sidebar nav
const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const now = Date.now();
createExecution(db, { id: LIVE_ID,   agent: null, skill: "smoke-test",     inputRef: null, tmuxSession: `vos-run-${LIVE_ID}`,   now, triggerId: null, stepCeiling: null });
createExecution(db, { id: REAPED_ID, agent: null, skill: "skill-author",   inputRef: null, tmuxSession: `vos-run-${REAPED_ID}`, now, triggerId: null, stepCeiling: null });
createExecution(db, { id: EXITED_ID, agent: null, skill: "deep-research",  inputRef: null, tmuxSession: `vos-run-${EXITED_ID}`, now, triggerId: null, stepCeiling: null });
createExecution(db, { id: PRECID_ID, agent: null, skill: "smoke-test",     inputRef: null, tmuxSession: `vos-run-${PRECID_ID}`, now, triggerId: null, stepCeiling: null });

const app = makeApp(VAULT, db);
const server = Bun.serve({ port: 0, fetch: app.fetch });
console.log(`READY http://127.0.0.1:${server.port}`);
console.log(`VAULT ${VAULT}`);
