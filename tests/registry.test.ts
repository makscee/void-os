// registry.test.ts — unit tests for executions schema (ADR-0003 §2) and trigger helpers.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  openRegistry, createExecution, setExecutionEnded, getExecution,
  executionByTmuxSession, listExecutions, incrementStep, setExecutionFail,
  upsertTrigger, getTrigger, listTriggers, setTriggerFireTimes, setTriggerEnabled,
} from "../src/registry.ts";

test("openRegistry creates executions table with ADR-0003 columns and no runs/sessions", () => {
  const db = openRegistry(":memory:");
  const cols = (db.query("PRAGMA table_info(executions)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["id","agent","skill","input_ref","tmux_session","started_at","ended_at",
                   "produced_change","nudged","trigger_id","step_count","step_ceiling","reason"]) {
    expect(cols).toContain(c);
  }
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  expect(tables).not.toContain("runs");
  expect(tables).not.toContain("sessions");
  expect(tables).toContain("triggers"); // 189 survives
  db.close();
});

test("createExecution + getExecution round-trips a fresh execution", () => {
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-1", agent: null, skill: "smoke", inputRef: null,
    tmuxSession: "vos-run-exec-1", now: 1000, triggerId: null, stepCeiling: null });
  const e = getExecution(db, "exec-1")!;
  expect(e.skill).toBe("smoke");
  expect(e.started_at).toBe(1000);
  expect(e.ended_at).toBeNull();
  expect(e.produced_change).toBe(0);
  expect(e.nudged).toBe(0);
  db.close();
});

test("setExecutionEnded stamps ended_at", () => {
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-2", agent: null, skill: "s", inputRef: null,
    tmuxSession: "t", now: 1000, triggerId: null, stepCeiling: null });
  setExecutionEnded(db, "exec-2", 2000);
  expect(getExecution(db, "exec-2")!.ended_at).toBe(2000);
  db.close();
});

test("setExecutionEnded is idempotent — second call is a no-op", () => {
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-2b", agent: null, skill: "s", inputRef: null,
    tmuxSession: "t2b", now: 1000, triggerId: null, stepCeiling: null });
  setExecutionEnded(db, "exec-2b", 2000);
  setExecutionEnded(db, "exec-2b", 9999); // should not overwrite
  expect(getExecution(db, "exec-2b")!.ended_at).toBe(2000);
  db.close();
});

test("executionByTmuxSession finds the row", () => {
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-3", agent: null, skill: "s", inputRef: null,
    tmuxSession: "vos-run-exec-3", now: 1, triggerId: null, stepCeiling: null });
  expect(executionByTmuxSession(db, "vos-run-exec-3")!.id).toBe("exec-3");
  db.close();
});

test("step-ceiling helpers operate on executions", () => {
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-4", agent: null, skill: "s", inputRef: null,
    tmuxSession: "t", now: 1, triggerId: "tg", stepCeiling: 2 });
  expect(incrementStep(db, "exec-4")).toBe(1);
  expect(incrementStep(db, "exec-4")).toBe(2);
  setExecutionFail(db, "exec-4", "runaway-ceiling", 99);
  const e = getExecution(db, "exec-4")!;
  expect(e.reason).toBe("runaway-ceiling");
  expect(e.ended_at).toBe(99);
  db.close();
});

test("listExecutions returns newest-started first", () => {
  const db = openRegistry(":memory:");
  createExecution(db, { id: "a", agent: null, skill: "s", inputRef: null, tmuxSession: "t1", now: 100, triggerId: null, stepCeiling: null });
  createExecution(db, { id: "b", agent: null, skill: "s", inputRef: null, tmuxSession: "t2", now: 200, triggerId: null, stepCeiling: null });
  expect(listExecutions(db).map((e) => e.id)).toEqual(["b", "a"]);
  db.close();
});

test("an interactive execution has null trigger_id + null step_ceiling", () => {
  const db = openRegistry(":memory:");
  createExecution(db, { id: "exec-5", agent: null, skill: null, inputRef: null,
    tmuxSession: "vos-run-exec-5", now: 0, triggerId: null, stepCeiling: null });
  const e = getExecution(db, "exec-5")!;
  expect(e.trigger_id).toBeNull();
  expect(e.step_ceiling).toBeNull();
  db.close();
});

// --- Trigger helpers (must survive unchanged from VOS-189) ---

test("upsertTrigger inserts then updates idempotently; row carries runtime fields", () => {
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "morning", kind: "schedule", skill: "morning-report", agent: "default", cronExpr: "0 9 * * *", inbox: null, stepCeiling: 40, now: 1000 });
  let row = getTrigger(db, "morning")!;
  expect(row.kind).toBe("schedule");
  expect(row.step_ceiling).toBe(40);
  expect(row.enabled).toBe(1);
  expect(row.next_fire_at).toBeNull();
  upsertTrigger(db, { name: "morning", kind: "schedule", skill: "morning-report", agent: "default", cronExpr: "0 9 * * *", inbox: null, stepCeiling: 99, now: 2000 });
  row = getTrigger(db, "morning")!;
  expect(row.step_ceiling).toBe(99);
  expect(listTriggers(db).length).toBe(1);
  db.close();
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
  db.close();
});
