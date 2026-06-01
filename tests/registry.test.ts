// registry.test.ts — unit tests for SQLite runs+sessions schema and helpers.
import { test, expect } from "bun:test";
import {
  openRegistry,
  createSession,
  createRun,
  setRunState,
  setResumeToken,
  getRun,
  getSession,
  latestRunForSession,
  upsertTrigger,
  getTrigger,
  listTriggers,
  setTriggerFireTimes,
  setTriggerEnabled,
  incrementStep,
  setRunFail,
} from "../src/registry.ts";

test("openRegistry creates runs + sessions tables with expected columns", () => {
  const db = openRegistry(":memory:");
  const runCols = (db.query("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name);
  expect(runCols).toEqual(
    expect.arrayContaining([
      "id", "session_id", "tmux_session", "pid", "state",
      "started_at", "ended_at", "idle_since",
    ]),
  );
  const sesCols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((r) => r.name);
  expect(sesCols).toEqual(
    expect.arrayContaining([
      "id", "resume_token", "state", "agent", "skill", "created_at", "last_run_at",
    ]),
  );
  db.close();
});

test("createSession + createRun insert rows with starting states", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-1", agent: null, skill: "smoke-test", now: 1000 });
  createRun(db, { id: "run-1", sessionId: "ses-1", tmuxSession: "vos-run-run-1", pid: 42, now: 1000 });
  const r = getRun(db, "run-1");
  expect(r).not.toBeNull();
  expect(r!.state).toBe("spawning");
  expect(r!.tmux_session).toBe("vos-run-run-1");
  expect(getSession(db, "ses-1")!.resume_token).toBeNull();
  db.close();
});

test("setResumeToken fills only when NULL (first SessionStart wins)", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-2", agent: null, skill: "x", now: 1 });
  const first = setResumeToken(db, "ses-2", "cc-uuid-A", 2);
  const second = setResumeToken(db, "ses-2", "cc-uuid-B", 3);
  expect(first).toBe(true);   // filled
  expect(second).toBe(false); // already set, untouched
  expect(getSession(db, "ses-2")!.resume_token).toBe("cc-uuid-A");
  db.close();
});

test("setRunState walks the lifecycle and stamps ended_at on terminal", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-3", agent: null, skill: "x", now: 1 });
  createRun(db, { id: "run-3", sessionId: "ses-3", tmuxSession: "t", pid: 1, now: 1 });
  setRunState(db, "run-3", "running", 2);
  setRunState(db, "run-3", "idle", 3);
  setRunState(db, "run-3", "exited_ok", 4);
  const r = getRun(db, "run-3");
  expect(r!.state).toBe("exited_ok");
  expect(r!.ended_at).toBe(4);
  expect(r!.idle_since).toBeNull(); // cleared on terminal
  expect(latestRunForSession(db, "ses-3")!.id).toBe("run-3");
  db.close();
});

test("setRunState sets idle_since when transitioning to idle", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-4", agent: null, skill: "x", now: 1 });
  createRun(db, { id: "run-4", sessionId: "ses-4", tmuxSession: "t4", pid: 1, now: 1 });
  setRunState(db, "run-4", "running", 5);
  setRunState(db, "run-4", "idle", 10);
  const r = getRun(db, "run-4");
  expect(r!.state).toBe("idle");
  expect(r!.idle_since).toBe(10);
  db.close();
});

// --- Task 3 tests: triggers table + runs trigger_id/step_count/step_ceiling/reason ---

test("upsertTrigger inserts then updates idempotently; row carries runtime fields", () => {
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "morning", kind: "schedule", skill: "morning-report", agent: "default", cronExpr: "0 9 * * *", inbox: null, stepCeiling: 40, now: 1000 });
  let row = getTrigger(db, "morning")!;
  expect(row.kind).toBe("schedule");
  expect(row.step_ceiling).toBe(40);
  expect(row.enabled).toBe(1);
  expect(row.next_fire_at).toBeNull(); // set separately by the scheduler
  // upsert again with a changed ceiling — same row, updated
  upsertTrigger(db, { name: "morning", kind: "schedule", skill: "morning-report", agent: "default", cronExpr: "0 9 * * *", inbox: null, stepCeiling: 99, now: 2000 });
  row = getTrigger(db, "morning")!;
  expect(row.step_ceiling).toBe(99);
  expect(listTriggers(db).length).toBe(1);
});

test("setTriggerFireTimes + setTriggerEnabled update runtime projection", () => {
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "m", kind: "manual", skill: "s", agent: "a", cronExpr: null, inbox: null, stepCeiling: 50, now: 0 });
  setTriggerFireTimes(db, "m", { nextFireAt: 5000, lastFiredAt: 4000 });
  const row = getTrigger(db, "m")!;
  expect(row.next_fire_at).toBe(5000);
  expect(row.last_fired_at).toBe(4000);
  setTriggerEnabled(db, "m", false);
  expect(getTrigger(db, "m")!.enabled).toBe(0);
});

test("a Run created for a Trigger carries trigger_id + step_ceiling; incrementStep counts", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s1", agent: "a", skill: "sk", now: 0 });
  createRun(db, { id: "r1", sessionId: "s1", tmuxSession: "vos-run-r1", pid: 1, now: 0, triggerId: "morning", stepCeiling: 3 });
  const r = getRun(db, "r1")!;
  expect(r.trigger_id).toBe("morning");
  expect(r.step_ceiling).toBe(3);
  expect(r.step_count).toBe(0);
  expect(incrementStep(db, "r1")).toBe(1);
  expect(incrementStep(db, "r1")).toBe(2);
  expect(getRun(db, "r1")!.step_count).toBe(2);
});

test("an interactive Run has null trigger_id + null step_ceiling", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s2", agent: null, skill: null, now: 0 });
  createRun(db, { id: "r2", sessionId: "s2", tmuxSession: "vos-run-r2", pid: 2, now: 0 });
  const r = getRun(db, "r2")!;
  expect(r.trigger_id).toBeNull();
  expect(r.step_ceiling).toBeNull();
});

test("setRunFail records terminal state + reason", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s3", agent: null, skill: null, now: 0 });
  createRun(db, { id: "r3", sessionId: "s3", tmuxSession: "t", pid: 3, now: 0 });
  setRunFail(db, "r3", "runaway-ceiling", 1234);
  const r = getRun(db, "r3")!;
  expect(r.state).toBe("exited_fail");
  expect(r.reason).toBe("runaway-ceiling");
  expect(r.ended_at).toBe(1234);
});
