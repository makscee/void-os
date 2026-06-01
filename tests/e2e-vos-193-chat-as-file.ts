/**
 * VOS-193 E2E: chat trigger → fresh CC execution reads thread file → reply appended.
 *
 * Fires the chat trigger directly (trigger-fired, print mode) against a pre-seeded
 * thread history file. Asserts a chat executions row is created + the thread file
 * gains an ## assistant reply (produced_change=1). Uses real vc/CC in print mode
 * (same pattern as vos-proof-vos190.sh + vos-proof-vos192.sh).
 *
 * Requires: vc authenticated, tmux, bun, void-os daemon source.
 * Run: bun run tests/e2e-vos-193-chat-as-file.ts
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname_e2e = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname_e2e, "..");
const VAULT = "/tmp/void-os-e2e-vos193";
const PORT = 4420;
const BASE = `http://localhost:${PORT}`;
const THREAD = "e2e-chat";

// Registry helpers — read-only connection to avoid WAL conflicts.
const { openRegistry, getExecution, listExecutions } = await import(`${REPO_ROOT}/src/registry.ts`);
const { registryDbPath, chatThreadPath } = await import(`${REPO_ROOT}/src/paths.ts`);

// ---- setup ----
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "inbox"), { recursive: true });
mkdirSync(join(VAULT, "triggers"), { recursive: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
mkdirSync(join(VAULT, "chat"), { recursive: true });
mkdirSync(join(VAULT, ".claude", "skills", "chat"), { recursive: true });

// Pre-seed a user turn in the thread file (simulates what serve.ts does after drainInbox).
const threadFile = chatThreadPath(VAULT, THREAD);
writeFileSync(threadFile, `\n## user (${new Date().toISOString()})\n\nhello from e2e\n`);

// ---- void-os.json: use vc -- (real CC in print mode) ----
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT,
  onboarded: true,
  skills: ["chat"],
  answers: {},
  port: PORT,
  runners: [{ label: "vc (relay)", command: "vc --" }],
  defaultRunner: "vc (relay)",
}, null, 2));

// ---- Chat trigger ----
writeFileSync(join(VAULT, "triggers", "chat.md"), `---
name: chat
kind: event
skill: chat
agent: default
inbox: bus
event_kind: chat
step_ceiling: 30
---
`);

// ---- Copy chat skill into vault ----
const catalogSkillSrc = join(REPO_ROOT, "catalog", "skills", "chat", "SKILL.md");
writeFileSync(join(VAULT, ".claude", "skills", "chat", "SKILL.md"), readFileSync(catalogSkillSrc, "utf8"));

console.log("=== VOS-193 E2E: chat trigger → CC execution → reply appended ===");
console.log(`VAULT: ${VAULT}  PORT: ${PORT}`);
console.log(`Thread file: ${threadFile}`);
console.log("Starting daemon...");

const server = spawn("bun", ["run", "src/cli.ts", "serve", "--no-open"], {
  cwd: REPO_ROOT,
  env: { ...process.env, VOID_OS_VAULT: VAULT, VOID_OS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout?.on("data", (d: Buffer) => process.stdout.write(`[daemon] ${d}`));
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[daemon] ${d}`));

let ok = true;
const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) { errors.push(`FAIL: ${msg}`); ok = false; console.error(`FAIL: ${msg}`); }
  else console.log(`PASS: ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(fn: () => T | null | Promise<T | null>, ms = 30000, tick = 1000): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v != null) return v;
    await sleep(tick);
  }
  return null;
}

// Wait for daemon ready
const daemonReady = await waitFor(async () => {
  try {
    const r = await fetch(`${BASE}/`);
    return r.ok ? true : null;
  } catch { return null; }
}, 20000, 500);

if (!daemonReady) {
  assert(false, "daemon did not start within 20s");
  server.kill();
  process.exit(1);
}
console.log("Daemon ready.");
await sleep(500); // let boot reconcile finish

// ---- Verify chat trigger was reconciled ----
console.log("\n[Step 1] Verify chat trigger reconciled");
const triggersResp = await fetch(`${BASE}/triggers/chat`);
assert(triggersResp.ok, `GET /triggers/chat returns ok (got ${triggersResp.status})`);

// ---- Fire chat trigger with thread file as input ----
console.log("\n[Step 2] Fire chat trigger with thread file as input");
const BEFORE_TS = Date.now();
const fireResp = await fetch(`${BASE}/triggers/chat/fire`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input: threadFile }),
});
console.log(`/triggers/chat/fire → ${fireResp.status}`);
assert(fireResp.ok || fireResp.status === 302, `/triggers/chat/fire accepted (got ${fireResp.status})`);

// ---- Poll for executions row ----
console.log("\n[Step 3] Poll for chat executions row");
const dbPath = registryDbPath(VAULT);

const chatExec = await waitFor(() => {
  if (!existsSync(dbPath)) return null;
  const db = openRegistry(dbPath);
  const execs = listExecutions(db);
  return execs.find((e: { skill: string; started_at: number }) =>
    e.skill && e.skill.startsWith("chat") && e.started_at >= BEFORE_TS) ?? null;
}, 20000, 1000);

assert(chatExec != null, "a chat executions row was created with started_at set");
if (!chatExec) {
  server.kill();
  process.exit(1);
}
const execId = chatExec.id;
console.log(`  exec id: ${execId}  skill: "${chatExec.skill}"`);

// ---- Wait for CC to append the reply (produced_change=1) ----
console.log("\n[Step 4] Wait for reply appended to thread file (max 180s for CC cold start)");

const replyRow = await waitFor(() => {
  if (!existsSync(dbPath)) return null;
  const db = openRegistry(dbPath);
  const exec = getExecution(db, execId);
  if (!exec || !exec.ended_at) return null;
  return exec;
}, 180000, 2000);

assert(replyRow != null, "execution ended (ended_at set by real CC hooks)");

if (replyRow) {
  const threadContent = existsSync(threadFile) ? readFileSync(threadFile, "utf8") : "";
  const hasAssistant = threadContent.includes("## assistant");
  assert(hasAssistant, "thread file contains ## assistant reply");
  assert(replyRow.produced_change === 1, `produced_change=1 (got ${replyRow.produced_change})`);
  if (hasAssistant) {
    const userIdx = threadContent.indexOf("## user");
    const assistantIdx = threadContent.indexOf("## assistant");
    assert(userIdx < assistantIdx, "user turn precedes assistant turn in thread file");
    console.log(`  thread excerpt:\n${threadContent.slice(0, 400)}`);
  }
}

// ---- Teardown ----
server.kill();
await sleep(500);

if (!ok) {
  console.error(`\n=== VOS-193 E2E FAILED ===`);
  for (const e of errors) console.error(e);
  process.exit(1);
} else {
  console.log("\n=== VOS-193 E2E PASSED ===");
}
