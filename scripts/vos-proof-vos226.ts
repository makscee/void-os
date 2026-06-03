// vos-proof-vos226.ts — REAL-PATH proof for VOS-226 native-fs audit hooks.
//
// Asserts WIRING, not timing: a real CC PreToolUse Edit payload, POSTed to the REAL
// daemon `/hook` HTTP route (the exact path scripts/vos-hook-relay.sh uses), causes
// exactly one schema-conformant audit line to land in <vault>/.void-os/audit.jsonl —
// and that the line was triggered BY that write (path/tool/bytes derived from the payload).
//
// Run: bun scripts/vos-proof-vos226.ts
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, createExecution } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { auditPath } from "../src/audit.ts";

function fail(msg: string): never { console.error("PROOF FAIL:", msg); process.exit(1); }
function ok(msg: string) { console.log("  ok:", msg); }

const vault = mkdtempSync(join(tmpdir(), "vos226-proof-"));
const db = openRegistry(":memory:");

// A hand-launched interactive CC session row (null step_ceiling — the common case).
// SessionStart would self-register this in prod; we pre-create so the proof targets the audit branch.
const runId = "exec-proof-session";
createExecution(db, { id: runId, agent: "maya", skill: null, inputRef: null,
  tmuxSession: "t-proof", now: Date.now(), triggerId: null, stepCeiling: null });

const app = makeApp(vault, db);

// --- The REAL native write CC is about to make, in CC's PreToolUse payload shape. ---
const targetRel = "work/tasks/active/PROOF.md";
const targetAbs = join(vault, targetRel);
mkdirSync(join(vault, "work/tasks/active"), { recursive: true });
const content = "# proof\nthis is the content the agent's Edit will write\n";

const ccPreToolUsePayload = {
  hook_event_name: "PreToolUse",
  session_id: "11111111-2222-3333-4444-555555555555",
  tool_name: "Edit",
  tool_input: { file_path: targetAbs, content },
  // CC sends more fields (cwd, transcript_path, ...) — handler must ignore the rest.
  cwd: vault,
  transcript_path: "/tmp/whatever.jsonl",
};

const before = Date.now();

// POST through the REAL /hook route — the same route vos-hook-relay.sh hits in prod.
const res = await app.request(`/hook?run=${runId}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(ccPreToolUsePayload),
});
if (res.status !== 200) fail(`/hook returned ${res.status}, expected 200 (a hook must never 5xx)`);
ok("POST /hook?run=… returned 200");

// --- WIRING ASSERTION 1: the write triggered an audit line on disk. ---
if (!existsSync(auditPath(vault))) fail("no audit.jsonl was created — the hook did not emit a native audit line");
const lines = readFileSync(auditPath(vault), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (lines.length !== 1) fail(`expected exactly ONE audit line, got ${lines.length}: ${JSON.stringify(lines)}`);
ok("exactly one audit line on disk");

const line = lines[0];

// --- WIRING ASSERTION 2: every field derives from THIS write (not a fixture). ---
const expectedBytes = Buffer.byteLength(content);
const checks: Array<[string, unknown, unknown]> = [
  ["tool", line.tool, "Edit"],
  ["path", line.path, targetRel],
  ["bytes", line.bytes, expectedBytes],
  ["source", line.source, "native"],
  ["exec", line.exec, runId],
  ["agent", line.agent, "maya"],
];
for (const [field, got, want] of checks) {
  if (got !== want) fail(`audit.${field} = ${JSON.stringify(got)}, expected ${JSON.stringify(want)} (derived from the write)`);
}
ok(`line derives from the write: tool=Edit path=${targetRel} bytes=${expectedBytes} source=native exec=${runId} agent=maya`);

// --- WIRING ASSERTION 3: ts is fresh (set at hook time, not a hardcoded fixture). ---
if (!(typeof line.ts === "number" && line.ts >= before && line.ts <= Date.now() + 1000)) {
  fail(`audit.ts=${line.ts} is not a fresh hook-time epoch-ms (expected >= ${before})`);
}
ok(`ts is fresh hook-time epoch-ms (${line.ts})`);

// --- WIRING ASSERTION 4: audit-only — denied flag absent for a normal write, no block. ---
if ("denied" in line) fail("denied present on a non-DENY write (should be implicit false)");
ok("denied implicit-false on a normal write (audit-only, no enforcement)");

// --- NEGATIVE WIRING: a Bash PreToolUse on the SAME route emits NO new line. ---
await app.request(`/hook?run=${runId}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "x", tool_name: "Bash", tool_input: { command: "ls" } }),
});
const after = readFileSync(auditPath(vault), "utf8").split("\n").filter(Boolean);
if (after.length !== 1) fail(`Bash PreToolUse added an audit line (got ${after.length}) — non-fs tools must NOT be audited`);
ok("Bash PreToolUse via the same route added NO audit line (only fs writes are traced)");

console.log("\nPROOF PASS: real CC PreToolUse Edit → /hook route → exactly one conformant native audit line, triggered by that write.");
console.log("audit.jsonl:", auditPath(vault));
console.log("line:", JSON.stringify(line));
