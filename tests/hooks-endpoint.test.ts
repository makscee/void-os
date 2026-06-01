// hooks-endpoint.test.ts — unit tests for hook→executions mapping + settings writer.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openRegistry,
  createExecution,
  getExecution,
} from "../src/registry.ts";
import { appendEvent } from "../src/events.ts";
import { handleHookEvent, buildHookSettings } from "../src/hooks-endpoint.ts";

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
