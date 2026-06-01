// tests/trigger.test.ts
import { expect, test } from "bun:test";
import { parseTrigger, DEFAULT_STEP_CEILING } from "../src/trigger.ts";

const MANUAL = `---
kind: manual
skill: morning-report
agent: default
step_ceiling: 40
---
Manual trigger body (ignored).`;

const SCHEDULE = `---
kind: schedule
skill: morning-report
agent: default
cron_expr: "0 9 * * *"
---
`;

const EVENT = `---
kind: event
skill: triage-inbox
agent: default
inbox: avito
---
`;

test("parseTrigger reads a manual trigger with explicit ceiling", () => {
  const t = parseTrigger("morning", MANUAL);
  expect(t.name).toBe("morning");
  expect(t.kind).toBe("manual");
  expect(t.skill).toBe("morning-report");
  expect(t.agent).toBe("default");
  expect(t.stepCeiling).toBe(40);
  expect(t.cronExpr).toBeNull();
  expect(t.inbox).toBeNull();
});

test("parseTrigger applies the default ceiling when omitted", () => {
  const t = parseTrigger("sched", SCHEDULE);
  expect(t.kind).toBe("schedule");
  expect(t.cronExpr).toBe("0 9 * * *");
  expect(t.stepCeiling).toBe(DEFAULT_STEP_CEILING);
});

test("parseTrigger reads an event trigger's inbox", () => {
  const t = parseTrigger("inbox-t", EVENT);
  expect(t.kind).toBe("event");
  expect(t.inbox).toBe("avito");
});

test("parseTrigger throws on a schedule with an invalid cron", () => {
  const bad = `---\nkind: schedule\nskill: x\nagent: default\ncron_expr: "nope"\n---\n`;
  expect(() => parseTrigger("bad", bad)).toThrow(/cron/i);
});

test("parseTrigger throws on a schedule missing cron_expr", () => {
  const bad = `---\nkind: schedule\nskill: x\nagent: default\n---\n`;
  expect(() => parseTrigger("bad", bad)).toThrow(/cron_expr/);
});

test("parseTrigger throws on an event missing inbox", () => {
  const bad = `---\nkind: event\nskill: x\nagent: default\n---\n`;
  expect(() => parseTrigger("bad", bad)).toThrow(/inbox/);
});

test("parseTrigger throws on an unknown kind", () => {
  const bad = `---\nkind: webhook\nskill: x\nagent: default\n---\n`;
  expect(() => parseTrigger("bad", bad)).toThrow(/kind/);
});
