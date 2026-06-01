// src/triggers-reconcile.ts — load Trigger files into triggers rows.
// One responsibility: filesystem→registry projection (no firing, no spawning).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { triggersDir } from "./paths.ts";
import { parseTrigger } from "./trigger.ts";
import { upsertTrigger, setTriggerFireTimes, getTrigger } from "./registry.ts";
import { nextFireAt } from "./cron.ts";

/** Reconcile all `vault/triggers/*.md` files into `triggers` rows. Malformed files are skipped (logged). */
export function reconcileTriggers(db: Database, vault: string, now: number): void {
  const dir = triggersDir(vault);
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const name = file.replace(/\.md$/, "");
    try {
      const spec = parseTrigger(name, readFileSync(join(dir, file), "utf8"));
      upsertTrigger(db, {
        name: spec.name,
        kind: spec.kind,
        skill: spec.skill,
        agent: spec.agent,
        cronExpr: spec.cronExpr,
        inbox: spec.inbox,
        stepCeiling: spec.stepCeiling,
        now,
      });
      if (spec.kind === "schedule" && spec.cronExpr) {
        // Only set next_fire_at when null (first-time load or after file was edited).
        // The scheduler tick fires the run and advances next_fire_at after each fire.
        // We must NOT overwrite a past-due next_fire_at here — that would skip the due fire.
        const existing = getTrigger(db, name);
        if (!existing?.next_fire_at) {
          setTriggerFireTimes(db, name, { nextFireAt: nextFireAt(spec.cronExpr, now) });
        }
      }
    } catch (e) {
      console.error(`[triggers] skipping ${file}: ${e}`);
    }
  }
}
