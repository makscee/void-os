// hooks-endpoint.test.ts — unit tests for hook→registry mapping + settings writer.
import { test, expect } from "bun:test";
import {
  openRegistry,
  createSession,
  createRun,
  getRun,
  getSession,
} from "../src/registry.ts";
import { handleHookEvent, buildHookSettings } from "../src/hooks-endpoint.ts";

function seed() {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-1", agent: null, skill: "x", now: 1 });
  createRun(db, { id: "run-1", sessionId: "ses-1", tmuxSession: "vos-run-run-1", pid: 1, now: 1 });
  return db;
}

test("SessionStart → run running + fills resume_token from payload session_id", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "SessionStart", session_id: "cc-uuid-1", source: "startup" }, 10);
  expect(getRun(db, "run-1")!.state).toBe("running");
  expect(getSession(db, "ses-1")!.resume_token).toBe("cc-uuid-1");
});

test("Stop → run idle", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "SessionStart", session_id: "cc-1", source: "startup" }, 10);
  handleHookEvent(db, "run-1", { hook_event_name: "Stop", session_id: "cc-1", stop_hook_active: false }, 20);
  expect(getRun(db, "run-1")!.state).toBe("idle");
});

test("SessionEnd → run exited_ok", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "SessionEnd", session_id: "cc-1", reason: "prompt_input_exit" }, 30);
  expect(getRun(db, "run-1")!.state).toBe("exited_ok");
});

// StopFailure is NOT a real CC hook event — removed.
// exited_fail is detected via the daemon-synthetic ProcessExit event fired by vos-run-wrapper.sh.

test("ProcessExit with non-zero exit code → run exited_fail (when not already terminal)", () => {
  const db = seed();
  // Run is in spawning state; non-zero exit → exited_fail
  handleHookEvent(db, "run-1", { hook_event_name: "ProcessExit", session_id: "", exit_code: 1 }, 40);
  expect(getRun(db, "run-1")!.state).toBe("exited_fail");
});

test("ProcessExit with exit code 0 → no-op (state unchanged)", () => {
  const db = seed();
  // Run is in spawning state; zero exit → no state change
  handleHookEvent(db, "run-1", { hook_event_name: "ProcessExit", session_id: "", exit_code: 0 }, 40);
  expect(getRun(db, "run-1")!.state).toBe("spawning"); // unchanged
});

test("ProcessExit after SessionEnd → no-op (already terminal, must not clobber exited_ok)", () => {
  const db = seed();
  // Normal exit: SessionEnd fires first (exited_ok), then wrapper fires ProcessExit.
  // The terminal-state guard must prevent overwriting exited_ok with exited_fail.
  handleHookEvent(db, "run-1", { hook_event_name: "SessionEnd", session_id: "cc-1" }, 30);
  handleHookEvent(db, "run-1", { hook_event_name: "ProcessExit", session_id: "", exit_code: 1 }, 35);
  expect(getRun(db, "run-1")!.state).toBe("exited_ok"); // must NOT become exited_fail
});

test("a second Run on the same session reuses the existing resume_token (setResumeToken NULL-guard)", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "SessionStart", session_id: "cc-1", source: "startup" }, 10);
  // a fresh Run on the same session fires another SessionStart
  createRun(db, { id: "run-2", sessionId: "ses-1", tmuxSession: "vos-run-run-2", pid: 2, now: 50 });
  handleHookEvent(db, "run-2", { hook_event_name: "SessionStart", session_id: "cc-2", source: "resume" }, 60);
  // resume_token must still be the FIRST value (cc-1), not overwritten by cc-2
  expect(getSession(db, "ses-1")!.resume_token).toBe("cc-1");
});

test("handleHookEvent with unknown run id is a no-op (no throw)", () => {
  const db = seed();
  expect(() =>
    handleHookEvent(db, "run-does-not-exist", { hook_event_name: "SessionStart", session_id: "x" }, 1),
  ).not.toThrow();
});

test("handleHookEvent with unknown event type is a no-op (no throw)", () => {
  const db = seed();
  expect(() =>
    handleHookEvent(db, "run-1", { hook_event_name: "FutureEvent", session_id: "x" }, 1),
  ).not.toThrow();
});

test("buildHookSettings wires SessionStart/Stop/SessionEnd via type:command relay to the daemon", () => {
  const relayScript = "/opt/void-os/scripts/vos-hook-relay.sh";
  const s = buildHookSettings(relayScript, "http://127.0.0.1:4317", "run-1");
  const events = Object.keys(s.hooks);
  // Must include the three lifecycle events used for state transitions
  expect(events).toEqual(expect.arrayContaining(["SessionStart", "Stop", "SessionEnd"]));
  // Must NOT include the fake StopFailure event
  expect(events).not.toContain("StopFailure");
  const h = s.hooks.SessionStart[0].hooks[0];
  // Must use type:"command" (not type:"http")
  expect(h.type).toBe("command");
  // The command must embed the relay script, daemon URL, and run ID
  expect(h.command).toContain(relayScript);
  expect(h.command).toContain("http://127.0.0.1:4317");
  expect(h.command).toContain("run-1");
});

// --- Task 4 tests: PreToolUse step counter + runaway-ceiling kill ---

test("PreToolUse increments step_count for a trigger-fired run", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s", agent: "a", skill: "sk", now: 0 });
  createRun(db, { id: "r", sessionId: "s", tmuxSession: "vos-run-r", pid: 1, now: 0, triggerId: "t", stepCeiling: 3 });
  handleHookEvent(db, "r", { hook_event_name: "PreToolUse", session_id: "cc" }, 10);
  expect(getRun(db, "r")!.step_count).toBe(1);
});

test("PreToolUse breach kills the tmux session + marks exited_fail reason runaway-ceiling", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s", agent: "a", skill: "sk", now: 0 });
  createRun(db, { id: "r", sessionId: "s", tmuxSession: "vos-run-r", pid: 1, now: 0, triggerId: "t", stepCeiling: 2 });
  const killed: string[] = [];
  const kill = (sess: string) => { killed.push(sess); };
  handleHookEvent(db, "r", { hook_event_name: "PreToolUse", session_id: "cc" }, 10, kill); // count=1
  handleHookEvent(db, "r", { hook_event_name: "PreToolUse", session_id: "cc" }, 20, kill); // count=2 == ceiling → breach
  expect(killed).toEqual(["vos-run-r"]);
  const r = getRun(db, "r")!;
  expect(r.state).toBe("exited_fail");
  expect(r.reason).toBe("runaway-ceiling");
});

test("PreToolUse on an interactive run (null ceiling) never counts or kills", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s", agent: null, skill: null, now: 0 });
  createRun(db, { id: "r", sessionId: "s", tmuxSession: "vos-run-r", pid: 1, now: 0 });
  const killed: string[] = [];
  for (let i = 0; i < 100; i++) handleHookEvent(db, "r", { hook_event_name: "PreToolUse", session_id: "cc" }, i, (s) => killed.push(s));
  expect(getRun(db, "r")!.step_count).toBe(0);
  expect(killed).toEqual([]);
  expect(getRun(db, "r")!.state).toBe("spawning");
});
