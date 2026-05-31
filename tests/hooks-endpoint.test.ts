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

test("StopFailure → run exited_fail", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "StopFailure", session_id: "cc-1", error: "rate_limit" }, 40);
  expect(getRun(db, "run-1")!.state).toBe("exited_fail");
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

test("buildHookSettings wires SessionStart/Stop/SessionEnd/StopFailure to the daemon /hook url for this run", () => {
  const s = buildHookSettings("http://127.0.0.1:4317", "run-1");
  const events = Object.keys(s.hooks);
  expect(events).toEqual(
    expect.arrayContaining(["SessionStart", "Stop", "SessionEnd", "StopFailure"]),
  );
  const h = s.hooks.SessionStart[0].hooks[0];
  expect(h.type).toBe("http");
  expect(h.url).toBe("http://127.0.0.1:4317/hook?run=run-1");
});
