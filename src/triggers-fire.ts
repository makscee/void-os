// src/triggers-fire.ts — fire a Trigger → spawn a Run; compute due schedule triggers.
// One responsibility: trigger→Run firing + schedule due-selection. Spawn is injected.
import type { Database } from "bun:sqlite";
import { getTrigger, listTriggers, setTriggerFireTimes, type TriggerRow } from "./registry.ts";
import { nextFireAt } from "./cron.ts";

/** Minimal spawn surface fireTrigger needs (real impl = spawnRun from spawn.ts). */
export interface SpawnFn {
  (o: { skill: string; agent: string; triggerId: string; stepCeiling: number; input: string | null;
         inputRef?: string | null; forcePrint?: boolean | null }):
    { runId: string; tmuxSession: string };
}

export function fireTrigger(
  db: Database,
  name: string,
  ctx: { spawn: SpawnFn; now: number; input: string | null; forcePrint?: boolean | null },
): { runId: string } | null {
  const t = getTrigger(db, name);
  if (!t || !t.enabled) return null;
  const { runId } = ctx.spawn({
    skill: t.skill, agent: t.agent, triggerId: t.name, stepCeiling: t.step_ceiling, input: ctx.input,
    forcePrint: ctx.forcePrint ?? null,
  });
  const nextAt = t.kind === "schedule" && t.cron_expr ? nextFireAt(t.cron_expr, ctx.now) : t.next_fire_at;
  setTriggerFireTimes(db, name, { nextFireAt: nextAt, lastFiredAt: ctx.now });
  return { runId };
}

/** Enabled schedule triggers whose next_fire_at is set and <= now. */
export function dueTriggers(db: Database, now: number): TriggerRow[] {
  return listTriggers(db).filter(
    (t) => t.kind === "schedule" && t.enabled === 1 && t.next_fire_at != null && t.next_fire_at <= now,
  );
}
