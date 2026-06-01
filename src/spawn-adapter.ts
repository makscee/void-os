// src/spawn-adapter.ts — bind fireTrigger's injected SpawnFn to the real spawnRun.
import type { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnRun } from "./spawn.ts";
import { readConfig, resolveRunner } from "./paths.ts";
import { listCatalogSkills } from "./catalog.ts";
import type { SpawnFn } from "./triggers-fire.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CATALOG_ROOT = join(repoRoot, "catalog");

export function makeSpawnFn(
  db: Database,
  vault: string,
  daemonUrl: string,
  catalogRoot: string = DEFAULT_CATALOG_ROOT,
): SpawnFn {
  return (o) => {
    const cfg = readConfig(vault);
    const runnerCommand = resolveRunner(cfg);
    // Look up the skill's declared output_target from its SKILL.md frontmatter.
    const catalogSkills = listCatalogSkills(catalogRoot);
    const skillMeta = catalogSkills.find((s) => s.name === o.skill);
    const outputTarget = skillMeta?.outputTarget ?? null;
    // input rides as trailing slash-command text (appended after skill name)
    const skill = o.input ? `${o.skill} ${o.input}` : o.skill;
    return spawnRun({
      db,
      vault,
      daemonUrl,
      skill,
      agent: o.agent,
      runnerCommand,
      inputRef: o.inputRef ?? null, // wire inbox line ref for files-first input tracking
      triggerId: o.triggerId,
      stepCeiling: o.stepCeiling,
      outputTarget,
      forcePrint: o.forcePrint ?? null,
    });
  };
}
