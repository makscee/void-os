// tests/triggers-fire.test.ts
import { expect, test } from "bun:test";
import { openRegistry, upsertTrigger, getTrigger } from "../src/registry.ts";
import { fireTrigger, dueTriggers } from "../src/triggers-fire.ts";

test("fireTrigger calls spawn with the trigger's skill/agent/ceiling and stamps last_fired_at", () => {
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "m", kind: "manual", skill: "morning-report", agent: "default", cronExpr: null, inbox: null, stepCeiling: 42, now: 0 });
  const calls: any[] = [];
  const fakeSpawn = (o: any) => { calls.push(o); return { runId: "r1", sessionId: "s1", tmuxSession: "t" }; };
  fireTrigger(db, "m", { spawn: fakeSpawn, now: 1000, input: null });
  expect(calls[0].skill).toBe("morning-report");
  expect(calls[0].agent).toBe("default");
  expect(calls[0].triggerId).toBe("m");
  expect(calls[0].stepCeiling).toBe(42);
  expect(getTrigger(db, "m")!.last_fired_at).toBe(1000);
});

test("fireTrigger on a schedule recomputes next_fire_at", () => {
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "s", kind: "schedule", skill: "x", agent: "default", cronExpr: "0 9 * * *", inbox: null, stepCeiling: 50, now: 0 });
  const fakeSpawn = () => ({ runId: "r", sessionId: "s", tmuxSession: "t" });
  const now = Date.UTC(2026, 5, 1, 9, 0, 0);
  fireTrigger(db, "s", { spawn: fakeSpawn, now, input: null });
  expect(getTrigger(db, "s")!.next_fire_at).toBe(Date.UTC(2026, 5, 2, 9, 0, 0));
});

test("dueTriggers returns enabled schedule triggers whose next_fire_at <= now", () => {
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "due", kind: "schedule", skill: "x", agent: "a", cronExpr: "0 9 * * *", inbox: null, stepCeiling: 50, now: 0 });
  db.query("UPDATE triggers SET next_fire_at = 500 WHERE name = 'due'").run();
  upsertTrigger(db, { name: "future", kind: "schedule", skill: "x", agent: "a", cronExpr: "0 9 * * *", inbox: null, stepCeiling: 50, now: 0 });
  db.query("UPDATE triggers SET next_fire_at = 9999 WHERE name = 'future'").run();
  const due = dueTriggers(db, 1000);
  expect(due.map((t) => t.name)).toEqual(["due"]);
});

test("dueTriggers excludes disabled triggers", () => {
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "off", kind: "schedule", skill: "x", agent: "a", cronExpr: "0 9 * * *", inbox: null, stepCeiling: 50, now: 0 });
  db.query("UPDATE triggers SET next_fire_at = 500, enabled = 0 WHERE name = 'off'").run();
  expect(dueTriggers(db, 1000)).toEqual([]);
});
