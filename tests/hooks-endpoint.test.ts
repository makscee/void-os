// hooks-endpoint.test.ts — unit tests for hook→executions mapping + settings writer.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDir } from "../src/paths.ts";
import {
  openRegistry,
  createExecution,
  getExecution,
} from "../src/registry.ts";
import { appendEvent } from "../src/events.ts";
import { handleHookEvent, buildHookSettings, runIdForSession, buildVaultHookSettings } from "../src/hooks-endpoint.ts";

function tmpVault() { return mkdtempSync(join(tmpdir(), "vos-hook-")); }

function setup() {
  const vault = tmpVault();
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-1", agent: null, skill: "s", inputRef: null,
    tmuxSession: "vos-run-exec-1", now: 1000, triggerId: null, stepCeiling: null });
  return { vault, db };
}

test("SessionEnd stamps ended_at on the execution", () => {
  const { vault, db } = setup();
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "SessionEnd", session_id: "" }, 2000);
  expect(getExecution(db, "exec-1")!.ended_at).toBe(2000);
});

test("ProcessExit with zero exit code stamps ended_at", () => {
  const { vault, db } = setup();
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "ProcessExit", session_id: "", exit_code: 0 }, 2000);
  expect(getExecution(db, "exec-1")!.ended_at).toBe(2000);
  expect(getExecution(db, "exec-1")!.reason).toBeNull();
});

test("ProcessExit non-zero marks the execution failed", () => {
  const { vault, db } = setup();
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "ProcessExit", session_id: "", exit_code: 1 }, 2000);
  const e = getExecution(db, "exec-1")!;
  expect(e.ended_at).toBe(2000);
  expect(e.reason).toBe("process-exit-nonzero");
});

test("SessionEnd after SessionEnd is a no-op (already terminal guard)", () => {
  const { vault, db } = setup();
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "SessionEnd", session_id: "" }, 2000);
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "SessionEnd", session_id: "" }, 9999);
  expect(getExecution(db, "exec-1")!.ended_at).toBe(2000); // not overwritten
});

test("PreToolUse over ceiling kills + fails (trigger-fired only)", () => {
  const { vault } = setup();
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-2", agent: null, skill: "s", inputRef: null,
    tmuxSession: "t", now: 1, triggerId: "tg", stepCeiling: 1 });
  let killed = "";
  handleHookEvent(db, vault, "exec-2", { hook_event_name: "PreToolUse", session_id: "" }, 5, (t) => { killed = t; });
  const e = getExecution(db, "exec-2")!;
  expect(e.reason).toBe("runaway-ceiling");
  expect(killed).toBe("t");
});

test("PreToolUse on an interactive run (null ceiling) never counts or kills", () => {
  const { vault, db } = setup();
  const killed: string[] = [];
  for (let i = 0; i < 100; i++) {
    handleHookEvent(db, vault, "exec-1", { hook_event_name: "PreToolUse", session_id: "" }, i, (s) => killed.push(s));
  }
  expect(getExecution(db, "exec-1")!.step_count).toBe(0);
  expect(killed).toEqual([]);
  expect(getExecution(db, "exec-1")!.ended_at).toBeNull();
});

test("every handled SessionEnd hook appends a line to the event log", async () => {
  const { vault, db } = setup();
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "SessionEnd", session_id: "" }, 2000);
  const { readFileSync } = await import("node:fs");
  const log = readFileSync(join(vault, ".void-os", "events", "exec-1.jsonl"), "utf8");
  expect(log).toContain('"type":"end"');
});

test("every PreToolUse breach appends step + fail lines to the event log", async () => {
  const { vault } = setup();
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-3", agent: null, skill: "s", inputRef: null,
    tmuxSession: "t3", now: 1, triggerId: "tg", stepCeiling: 1 });
  handleHookEvent(db, vault, "exec-3", { hook_event_name: "PreToolUse", session_id: "" }, 5, () => {});
  const { readFileSync } = await import("node:fs");
  const log = readFileSync(join(vault, ".void-os", "events", "exec-3.jsonl"), "utf8");
  expect(log).toContain('"type":"step"');
  expect(log).toContain('"type":"fail"');
});

test("handleHookEvent with unknown execution id is a no-op (no throw)", () => {
  const { vault, db } = setup();
  expect(() =>
    handleHookEvent(db, vault, "exec-does-not-exist", { hook_event_name: "SessionStart", session_id: "x" }, 1),
  ).not.toThrow();
});

test("handleHookEvent with unknown event type is a no-op (no throw)", () => {
  const { vault, db } = setup();
  expect(() =>
    handleHookEvent(db, vault, "exec-1", { hook_event_name: "FutureEvent", session_id: "x" }, 1),
  ).not.toThrow();
});

test("SessionStart is a no-op (stateless model — no state mutation)", () => {
  const { vault, db } = setup();
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "SessionStart", session_id: "cc-uuid-1" }, 10);
  // execution should still be running (ended_at null, no state change)
  const e = getExecution(db, "exec-1")!;
  expect(e.ended_at).toBeNull();
});

test("Stop with no declared output_target is a pass-through (no nudge, allow stop)", () => {
  // setup() uses createExecution only (no start event → no output_target) = empty target
  const { vault, db } = setup();
  const decision = handleHookEvent(db, vault, "exec-1", { hook_event_name: "Stop", session_id: "" }, 20);
  expect(decision).toBeUndefined();
  expect(getExecution(db, "exec-1")!.nudged).toBe(0);
  expect(getExecution(db, "exec-1")!.ended_at).toBeNull();
});

test("SessionEnd records produced_change when output was written (print-mode path)", () => {
  const { vault, db } = setupWithTarget("reports/out.html");
  mkdirSync(join(vault, "reports"), { recursive: true });
  const f = join(vault, "reports/out.html");
  writeFileSync(f, "done");
  utimesSync(f, new Date(1500), new Date(1500)); // mtime after start(1000)
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "SessionEnd", session_id: "" }, 2000);
  const e = getExecution(db, "exec-1")!;
  expect(e.produced_change).toBe(1);
  expect(e.nudged).toBe(0);
  expect(e.ended_at).toBe(2000);
});

test("SessionEnd records produced_change=0 when output was NOT written (print-mode path)", () => {
  const { vault, db } = setupWithTarget("reports/out.html"); // file not created
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "SessionEnd", session_id: "" }, 2000);
  const e = getExecution(db, "exec-1")!;
  expect(e.produced_change).toBe(0);
  expect(e.nudged).toBe(0);
  expect(e.ended_at).toBe(2000);
});

// ---- Stop-branch: output-target tests (VOS-191) ----

function setupWithTarget(target: string) {
  const vault = mkdtempSync(join(tmpdir(), "vos-stop-"));
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-1", agent: null, skill: "s", inputRef: null,
    tmuxSession: "vos-run-exec-1", now: 1000, triggerId: null, stepCeiling: null });
  appendEvent(vault, "exec-1", { type: "start", agent: null, skill: "s", input_ref: null,
    tmux_session: "vos-run-exec-1", at: 1000, trigger_id: null, step_ceiling: null, output_target: target });
  return { vault, db };
}

test("Stop on a clean target nudges once: produced_change=false, nudged=true, returns block decision", () => {
  const { vault, db } = setupWithTarget("reports/out.html");
  const decision = handleHookEvent(db, vault, "exec-1",
    { hook_event_name: "Stop", session_id: "", stop_hook_active: false }, 2000);
  const e = getExecution(db, "exec-1")!;
  expect(e.produced_change).toBe(0);
  expect(e.nudged).toBe(1);
  expect(e.ended_at).toBeNull(); // stop was blocked — still alive
  expect(decision?.decision).toBe("block");
  expect(typeof decision?.reason).toBe("string");
});

test("nudge reason says Edit not Write/modify (VOS-218: steer agent to correct tool)", () => {
  // Agents must receive "Edit" not "Write/modify" in the nudge so they reach for the right tool.
  const { vault, db } = setupWithTarget("chat/general.md");
  const decision = handleHookEvent(db, vault, "exec-1",
    { hook_event_name: "Stop", session_id: "", stop_hook_active: false }, 2000);
  expect(decision?.decision).toBe("block");
  const reason = decision!.reason;
  expect(reason).toContain("Edit");
  expect(reason).not.toContain("Write/modify");
  expect(reason).toContain("chat/general.md"); // target name embedded
});

test("Stop on a mutated target: produced_change=true, no nudge, allows stop", () => {
  const { vault, db } = setupWithTarget("reports/out.html");
  mkdirSync(join(vault, "reports"), { recursive: true });
  const f = join(vault, "reports/out.html");
  writeFileSync(f, "done");
  utimesSync(f, new Date(1500), new Date(1500)); // mtime after start(1000)
  const decision = handleHookEvent(db, vault, "exec-1",
    { hook_event_name: "Stop", session_id: "", stop_hook_active: false }, 2000);
  const e = getExecution(db, "exec-1")!;
  expect(e.produced_change).toBe(1);
  expect(e.nudged).toBe(0);
  expect(decision).toBeUndefined();
});

test("second Stop after a nudge gives up: still clean, no second block, allows stop", () => {
  const { vault, db } = setupWithTarget("reports/out.html");
  // First Stop → nudge
  handleHookEvent(db, vault, "exec-1", { hook_event_name: "Stop", session_id: "", stop_hook_active: false }, 2000);
  // Second Stop (stop_hook_active = true) → give up
  const decision = handleHookEvent(db, vault, "exec-1",
    { hook_event_name: "Stop", session_id: "", stop_hook_active: true }, 3000);
  expect(getExecution(db, "exec-1")!.nudged).toBe(1);
  expect(decision).toBeUndefined(); // give-up, no second nudge
});

test("Stop with empty declared output_target is a pass-through (no nudge, allow stop)", () => {
  const { vault, db } = setupWithTarget(""); // empty target
  const decision = handleHookEvent(db, vault, "exec-1",
    { hook_event_name: "Stop", session_id: "", stop_hook_active: false }, 2000);
  expect(decision).toBeUndefined();
  expect(getExecution(db, "exec-1")!.nudged).toBe(0);
});

test("buildHookSettings wires SessionStart/Stop/SessionEnd/PreToolUse via type:command relay", () => {
  const relayScript = "/opt/void-os/scripts/vos-hook-relay.sh";
  const s = buildHookSettings(relayScript, "http://127.0.0.1:4317", "exec-1");
  const events = Object.keys(s.hooks);
  expect(events).toEqual(expect.arrayContaining(["SessionStart", "Stop", "SessionEnd", "PreToolUse"]));
  expect(events).not.toContain("StopFailure");
  const h = s.hooks.SessionStart[0].hooks[0];
  expect(h.type).toBe("command");
  expect(h.command).toContain(relayScript);
  expect(h.command).toContain("http://127.0.0.1:4317");
  expect(h.command).toContain("exec-1");
});

// ---- VOS-197: vault-native (hand-launched claude) tests ----

test("runIdForSession is deterministic and prefixed", () => {
  const a = runIdForSession("sess-abc-123");
  const b = runIdForSession("sess-abc-123");
  expect(a).toBe(b);                       // same session_id → same runId (idempotent SessionStart)
  expect(a.startsWith("exec-")).toBe(true); // same exec- namespace as spawnRun
  expect(runIdForSession("other")).not.toBe(a);
});

test("SessionStart on an unknown run creates the row + start event (hand-launch)", () => {
  const vault = mkdtempSync(join(tmpdir(), "vos197-"));
  const db = openRegistry(":memory:");
  const runId = runIdForSession("sess-handlaunch-1");
  expect(getExecution(db, runId)).toBeNull();

  handleHookEvent(db, vault, runId, {
    hook_event_name: "SessionStart", session_id: "sess-handlaunch-1", source: "startup",
  }, 1000);

  const row = getExecution(db, runId);
  expect(row).not.toBeNull();
  expect(row!.started_at).toBe(1000);
  expect(row!.ended_at).toBeNull();
  expect(row!.trigger_id).toBeNull();       // hand-launched: no trigger
  const { readStartEvent } = require("../src/events.ts");
  const start = readStartEvent(vault, runId);
  expect(start).not.toBeNull();
  expect(start!.at).toBe(1000);
});

test("SessionStart is idempotent — second fire does not duplicate", () => {
  const vault = mkdtempSync(join(tmpdir(), "vos197-"));
  const db = openRegistry(":memory:");
  const runId = runIdForSession("sess-handlaunch-2");
  const p = { hook_event_name: "SessionStart", session_id: "sess-handlaunch-2", source: "startup" };
  handleHookEvent(db, vault, runId, p, 2000);
  handleHookEvent(db, vault, runId, p, 2050);
  expect(getExecution(db, runId)!.started_at).toBe(2000); // first wins, not overwritten
});

test("SessionStart on an already-spawned row stays a no-op (daemon path unchanged)", () => {
  const vault = mkdtempSync(join(tmpdir(), "vos197-"));
  const db = openRegistry(":memory:");
  // simulate daemon spawn: row already present
  createExecution(db, { id: "exec-daemon", agent: null, skill: "x", inputRef: null,
    tmuxSession: "vos-run-exec-daemon", now: 500, triggerId: "t-1", stepCeiling: null });
  handleHookEvent(db, vault, "exec-daemon", {
    hook_event_name: "SessionStart", session_id: "whatever", source: "startup",
  }, 9999);
  expect(getExecution(db, "exec-daemon")!.started_at).toBe(500); // untouched
});

test("hand-launch Stop with no declared target allows stop, no nudge", () => {
  const vault = mkdtempSync(join(tmpdir(), "vos197-"));
  const db = openRegistry(":memory:");
  const runId = runIdForSession("sess-stop-1");
  handleHookEvent(db, vault, runId, { hook_event_name: "SessionStart", session_id: "sess-stop-1" }, 1000);

  const decision = handleHookEvent(db, vault, runId,
    { hook_event_name: "Stop", session_id: "sess-stop-1" }, 1100);
  expect(decision).toBeUndefined();                      // no block/nudge
  expect(getExecution(db, runId)!.nudged).toBe(0);

  handleHookEvent(db, vault, runId, { hook_event_name: "SessionEnd", session_id: "sess-stop-1", reason: "clear" }, 1200);
  expect(getExecution(db, runId)!.ended_at).toBe(1200);  // closed cleanly
});

test("buildVaultHookSettings emits lifecycle hooks with NO baked runId", () => {
  const s = buildVaultHookSettings("/abs/vos-hook-relay.sh", "http://127.0.0.1:4317");
  for (const ev of ["SessionStart", "Stop", "SessionEnd", "PreToolUse"]) {
    expect(s.hooks[ev]).toBeDefined();
    const cmd = s.hooks[ev][0].hooks[0].command;
    expect(cmd).toContain("/abs/vos-hook-relay.sh");
    expect(cmd).toContain("http://127.0.0.1:4317");
    expect(cmd).not.toMatch(/exec-/);   // NO per-exec runId baked in
  }
});

// VOS-203: SessionStart writes cc-actual-session.txt so form-resume uses the real CC session ID.
test("SessionStart writes cc-actual-session.txt with the payload session_id (form-resume fix)", () => {
  const vault = mkdtempSync(join(tmpdir(), "vos203-sessstart-"));
  const db = openRegistry(":memory:");
  const runId = "exec-form-resume-test";
  const actualSessionId = "bc32d01a-76c0-4047-a876-5326c5f71895";
  mkdirSync(sessionDir(vault, runId), { recursive: true });
  createExecution(db, { id: runId, agent: null, skill: "onboarding", inputRef: null,
    tmuxSession: `vos-run-${runId}`, now: 1000, triggerId: null, stepCeiling: null });
  handleHookEvent(db, vault, runId, {
    hook_event_name: "SessionStart", session_id: actualSessionId, source: "startup",
  }, 1000);
  const actualFile = join(sessionDir(vault, runId), "cc-actual-session.txt");
  expect(existsSync(actualFile)).toBe(true);
  expect(readFileSync(actualFile, "utf8")).toBe(actualSessionId);
});

test("SessionStart does NOT write cc-actual-session.txt for non-UUID session_id (guard)", () => {
  const vault = mkdtempSync(join(tmpdir(), "vos203-sessstart-guard-"));
  const db = openRegistry(":memory:");
  const runId = "exec-guard-test";
  mkdirSync(sessionDir(vault, runId), { recursive: true });
  createExecution(db, { id: runId, agent: null, skill: "s", inputRef: null,
    tmuxSession: `vos-run-${runId}`, now: 1000, triggerId: null, stepCeiling: null });
  handleHookEvent(db, vault, runId, {
    hook_event_name: "SessionStart", session_id: "not-a-uuid", source: "startup",
  }, 1000);
  expect(existsSync(join(sessionDir(vault, runId), "cc-actual-session.txt"))).toBe(false);
});

// ---- Native-fs audit capture (VOS-226 / contract §4.3) ----

import { auditPath, type AuditLine } from "../src/audit.ts";

function readAudit(vault: string): AuditLine[] {
  if (!existsSync(auditPath(vault))) return [];
  return readFileSync(auditPath(vault), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function setupAgent() {
  const vault = mkdtempSync(join(tmpdir(), "vos-audit-hook-"));
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-9", agent: "maya", skill: "s", inputRef: null,
    tmuxSession: "t9", now: 1000, triggerId: null, stepCeiling: null });
  return { vault, db };
}

test("PreToolUse Edit under the vault emits exactly one well-formed native audit line", () => {
  const { vault, db } = setupAgent();
  handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "Edit", tool_input: { file_path: join(vault, "work/tasks/active/X.md"), content: "hello" },
  }, 4242);
  const lines = readAudit(vault);
  expect(lines.length).toBe(1);
  expect(lines[0]).toEqual({
    ts: 4242, exec: "exec-9", agent: "maya", tool: "Edit",
    path: "work/tasks/active/X.md", bytes: 5, source: "native",
  });
});

test("PreToolUse with a vault-relative file_path resolves against the vault root", () => {
  const { vault, db } = setupAgent();
  handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "Write", tool_input: { file_path: "notes/n.md", content: "ab" },
  }, 1);
  const lines = readAudit(vault);
  expect(lines.length).toBe(1);
  expect(lines[0].path).toBe("notes/n.md");
  expect(lines[0].tool).toBe("Write");
  expect(lines[0].bytes).toBe(2);
});

test("PreToolUse for a non-fs tool (Bash/Read) emits NO audit line", () => {
  const { vault, db } = setupAgent();
  handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "Bash", tool_input: { command: "ls" } as any,
  }, 1);
  handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "", tool_name: "Read", tool_input: { file_path: join(vault, "a.md") },
  }, 2);
  expect(readAudit(vault).length).toBe(0);
});

test("PreToolUse fs-write OUTSIDE the vault emits NO audit line", () => {
  const { vault, db } = setupAgent();
  handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "Write", tool_input: { file_path: "/etc/passwd", content: "x" },
  }, 1);
  handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "Edit", tool_input: { file_path: join(vault, "..", "escape.md"), content: "x" },
  }, 2);
  expect(readAudit(vault).length).toBe(0);
});

test("PreToolUse fs-write to a SYSTEM_DENY path logs denied:true but does NOT block (audit-only)", () => {
  const { vault, db } = setupAgent();
  const decision = handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "Write", tool_input: { file_path: join(vault, "agents/maya.md"), content: "x" },
  }, 7);
  expect(decision).toBeUndefined();       // never blocks the native path in v1
  const lines = readAudit(vault);
  expect(lines.length).toBe(1);
  expect(lines[0].denied).toBe(true);
  expect(lines[0].path).toBe("agents/maya.md");
});

test("native audit fires on interactive runs (null step_ceiling) without touching step_count", () => {
  const { vault, db } = setupAgent();   // exec-9 has stepCeiling null
  handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "Edit", tool_input: { file_path: join(vault, "a.md"), content: "z" },
  }, 1);
  expect(readAudit(vault).length).toBe(1);
  expect(getExecution(db, "exec-9")!.step_count).toBe(0);  // ceiling logic untouched
});

test("native audit co-exists with the step-ceiling path (trigger run): audit line + step counted", () => {
  const vault = mkdtempSync(join(tmpdir(), "vos-audit-ceil-"));
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-10", agent: null, skill: "s", inputRef: null,
    tmuxSession: "t10", now: 1, triggerId: "tg", stepCeiling: 5 });
  handleHookEvent(db, vault, "exec-10", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "Write", tool_input: { file_path: join(vault, "a.md"), content: "z" },
  }, 1, () => {});
  expect(readAudit(vault).length).toBe(1);
  expect(getExecution(db, "exec-10")!.step_count).toBe(1);  // step still counted
});

test("MultiEdit is an audited fs tool; bytes best-effort 0 when no content field", () => {
  const { vault, db } = setupAgent();
  handleHookEvent(db, vault, "exec-9", {
    hook_event_name: "PreToolUse", session_id: "",
    tool_name: "MultiEdit", tool_input: { file_path: join(vault, "a.md") },
  }, 1);
  const lines = readAudit(vault);
  expect(lines.length).toBe(1);
  expect(lines[0].tool).toBe("MultiEdit");
  expect(lines[0].bytes).toBe(0);
});
