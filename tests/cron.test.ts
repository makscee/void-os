// tests/cron.test.ts
import { expect, test } from "bun:test";
import { nextFireAt, isValidCron } from "../src/cron.ts";

test("nextFireAt computes the next cron occurrence after a given epoch ms", () => {
  // 2026-06-01 08:30:00 UTC; cron "0 9 * * *" → next is 09:00 same day
  const after = Date.UTC(2026, 5, 1, 8, 30, 0);
  const next = nextFireAt("0 9 * * *", after);
  expect(next).toBe(Date.UTC(2026, 5, 1, 9, 0, 0));
});

test("nextFireAt rolls to next day when past today's time", () => {
  const after = Date.UTC(2026, 5, 1, 9, 30, 0);
  const next = nextFireAt("0 9 * * *", after);
  expect(next).toBe(Date.UTC(2026, 5, 2, 9, 0, 0));
});

test("isValidCron accepts valid and rejects garbage", () => {
  expect(isValidCron("0 9 * * *")).toBe(true);
  expect(isValidCron("not a cron")).toBe(false);
});
