// VOS-214 Phase 1 serve harness — dashboard + status-dot + layout fixture suite (S1 + S7).
// Seeds a test vault with:
//   - 6 sessions, one per status (stopped, error, reaped, awaiting, working, complete)
//   - 1 needsAttention session (body.html updated after last-opened.txt)
// Mounts makeApp, serves on a free port, prints "READY <baseUrl>" once listening.
// No live vc/claude/tmux. NEVER opens operator browser.
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { placeholderBody } from "../src/render.ts";
import { Database } from "bun:sqlite";

const VAULT = join(tmpdir(), "vos214-s1-e2e-vault");
// Vault path must be stable per tmpdir (cleared on each run)
const CC_ID = "abcdef01-2345-4678-89ab-cdef01234567";

// ---- UUIDs for each fixture session ----
export const SESS_STOPPED   = "s1-stopped-0000-0000-000000000001";
export const SESS_ERROR     = "s1-error000-0000-0000-000000000002";
export const SESS_REAPED    = "s1-reaped00-0000-0000-000000000003";
export const SESS_AWAITING  = "s1-awaiting-0000-0000-000000000004";
export const SESS_WORKING   = "s1-working0-0000-0000-000000000005";
export const SESS_COMPLETE  = "s1-complete-0000-0000-000000000006";
export const SESS_ATTENTION = "s1-attn0000-0000-0000-000000000007";

// ---- Clean slate ----
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT, onboarded: true, skills: ["skill-author"], answers: {}, port: 4317,
  runners: [{ label: "vc", command: "vc --" }], defaultRunner: "vc",
}));
// Seed a vault skill so listVaultSkills returns ≥1 chip (.skill-chip[data-skill])
// Skills live in <vault>/.claude/skills/<name>/SKILL.md
const skillDir = join(VAULT, ".claude", "skills", "skill-author");
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, "SKILL.md"), `---
name: skill-author
description: Author new void-os skills
version: 1.0.0
---
# skill-author
Write and deploy void-os skills.
`);

const sessions = join(VAULT, "sessions");
mkdirSync(sessions, { recursive: true });

const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const now = Date.now();

function seedSession(uuid: string, skill: string, lastOpened: boolean = true): string {
  const dir = join(sessions, uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session-meta.json"), JSON.stringify({ skill, interactive: false }));
  if (lastOpened) {
    // Write last-opened.txt with a future timestamp so needsAttention = false
    // (lastActivityMs <= loMtime means "no new work since last open")
    const futureTime = new Date(now + 60000); // 1 minute in the future
    writeFileSync(join(dir, "last-opened.txt"), String(now + 60000));
    utimesSync(join(dir, "last-opened.txt"), futureTime, futureTime);
  }
  return dir;
}

function insertExec(id: string, endedAt: number | null, reason: string | null = null): void {
  (db as Database).query(
    "INSERT INTO executions (id, agent, skill, input_ref, tmux_session, started_at, ended_at, produced_change, nudged, trigger_id, step_count, step_ceiling, reason) VALUES (?,?,?,?,?,?,?,0,0,?,0,?,?)"
  ).run(id, null, "skill-author", null, `vos-run-${id}`, now - 10000, endedAt, null, null, reason);
}

// ---- 1. stopped ----
{
  const dir = seedSession(SESS_STOPPED, "skill-author");
  writeFileSync(join(dir, "body.html"), placeholderBody("skill-author"));
  writeFileSync(join(dir, "stopped.txt"), "stopped");
  insertExec(SESS_STOPPED, now - 5000);
}

// ---- 2. error ----
{
  const dir = seedSession(SESS_ERROR, "skill-author");
  writeFileSync(join(dir, "body.html"), `<!doctype html><html><head><title>error session</title></head><body><p>error content</p></body></html>`);
  writeFileSync(join(dir, "error.txt"), "boom: something failed");
  insertExec(SESS_ERROR, now - 5000);
}

// ---- 3. reaped: reaped.txt + no live exec (ended) + ccId ----
{
  const dir = seedSession(SESS_REAPED, "skill-author");
  writeFileSync(join(dir, "body.html"), `<!doctype html><html><head><title>reaped session</title></head><body><p>reaped content</p></body></html>`);
  writeFileSync(join(dir, "reaped.txt"), "reaped");
  writeFileSync(join(dir, "cc-actual-session.txt"), CC_ID);
  insertExec(SESS_REAPED, now - 4000);
}

// ---- 4. awaiting: live exec + body has <form> ----
{
  const dir = seedSession(SESS_AWAITING, "skill-author");
  writeFileSync(join(dir, "body.html"), `<!doctype html><html><head><title>awaiting session</title></head><body><form action="/submit"><input name="answer" /><button type="submit">Submit</button></form></body></html>`);
  insertExec(SESS_AWAITING, null); // live exec: ended_at = null
}

// ---- 5. working: live exec + no form in body ----
{
  const dir = seedSession(SESS_WORKING, "skill-author");
  writeFileSync(join(dir, "body.html"), `<!doctype html><html><head><title>working session</title></head><body><p>Working on it...</p></body></html>`);
  insertExec(SESS_WORKING, null); // live exec: ended_at = null
}

// ---- 6. complete: ended exec cleanly, no form ----
{
  const dir = seedSession(SESS_COMPLETE, "skill-author");
  writeFileSync(join(dir, "body.html"), `<!doctype html><html><head><title>complete session</title></head><body><p>Complete results here.</p></body></html>`);
  insertExec(SESS_COMPLETE, now - 3000);
}

// ---- 7. needsAttention: body mtime > last-opened.txt mtime ----
// Do NOT pass lastOpened=true — we manage it manually to set it BEFORE body.html
{
  const dir = seedSession(SESS_ATTENTION, "skill-author", false /* no auto last-opened */);
  const bodyFile = join(dir, "body.html");
  const loFile = join(dir, "last-opened.txt");
  // Write last-opened.txt FIRST (older than body.html)
  const oldTime = new Date(now - 60000); // 1 minute ago
  writeFileSync(loFile, String(now - 60000));
  utimesSync(loFile, oldTime, oldTime);
  // Write body.html AFTER (newer mtime) so lastActivityMs > loMtime => needsAttention=true
  writeFileSync(bodyFile, `<!doctype html><html><head><title>attention session</title></head><body><p>New results arrived!</p></body></html>`);
  // body.html gets current mtime (newer than last-opened) — no explicit utimes needed
  insertExec(SESS_ATTENTION, now - 2000);
}

const app = makeApp(VAULT, db);
const server = Bun.serve({ port: 0, fetch: app.fetch });
console.log(`READY http://127.0.0.1:${server.port}`);
// Also export session IDs for the spec to consume
console.log(`SESSION_IDS ${JSON.stringify({
  stopped: SESS_STOPPED,
  error: SESS_ERROR,
  reaped: SESS_REAPED,
  awaiting: SESS_AWAITING,
  working: SESS_WORKING,
  complete: SESS_COMPLETE,
  attention: SESS_ATTENTION,
  vault: VAULT,
})}`);
