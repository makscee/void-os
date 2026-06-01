// src/spawn-adapter.ts — bind fireTrigger's injected SpawnFn to the real spawnRun.
import type { Database } from "bun:sqlite";
import { spawnRun } from "./spawn.ts";
import { readConfig, resolveRunner } from "./paths.ts";
import type { SpawnFn } from "./triggers-fire.ts";

export function makeSpawnFn(db: Database, vault: string, daemonUrl: string): SpawnFn {
  return (o) => {
    const cfg = readConfig(vault);
    const runnerCommand = resolveRunner(cfg);
    // input rides as trailing slash-command text (appended after skill name)
    const skill = o.input ? `${o.skill} ${o.input}` : o.skill;
    return spawnRun({
      db,
      vault,
      daemonUrl,
      skill,
      agent: o.agent,
      runnerCommand,
      triggerId: o.triggerId,
      stepCeiling: o.stepCeiling,
    });
  };
}
