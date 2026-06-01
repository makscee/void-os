// src/cron.ts — thin wrapper over cron-parser for next-fire computation.
// One responsibility: cron expression → next epoch-ms occurrence, and validation.
// Computed in UTC so tests are timezone-stable; the daemon runs in the host tz —
// document that schedule cron is interpreted in UTC at runtime (tz: "UTC" option).
import { CronExpressionParser } from "cron-parser";

/** Next occurrence strictly after `afterMs` (epoch ms), in UTC. Returns epoch ms. */
export function nextFireAt(cronExpr: string, afterMs: number): number {
  const interval = CronExpressionParser.parse(cronExpr, {
    currentDate: new Date(afterMs),
    tz: "UTC",
  });
  return interval.next().getTime();
}

/** True if `cronExpr` parses as a valid 5-field cron expression. */
export function isValidCron(cronExpr: string): boolean {
  try {
    CronExpressionParser.parse(cronExpr);
    return true;
  } catch {
    return false;
  }
}
