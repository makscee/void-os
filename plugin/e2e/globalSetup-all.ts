/**
 * VOS-107 T9: chained globalSetup that runs the shared (main) setup AND the
 * ask-user-isolated setup sequentially. Playwright supports only a single
 * top-level globalSetup, so we chain the two project setups here.
 *
 * Project gating: Playwright filters `config.projects` to only those selected
 * via `--project` before invoking globalSetup, so we boot only the daemons +
 * Obsidian windows the active project actually needs. Without this, a
 * `--project=ask-user` run still spawned the unused `main` daemon + Obsidian.
 */
import type { FullConfig } from "@playwright/test";
import sharedSetup from "./globalSetup.ts";
import askUserSetup from "./globalSetup-ask-user.ts";
import permissionDenyUiSetup from "./globalSetup-permission-deny-ui.ts";
import autospawnSetup from "./globalSetup-autospawn.ts";

// Playwright's FullConfig.projects is the full declared list, NOT filtered
// by --project. Parse argv directly. Empty filter = run all.
function selectedProjects(allNames: string[]): Set<string> {
  const argv = process.argv;
  const picks: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" && argv[i + 1]) picks.push(argv[i + 1]);
    else if (a.startsWith("--project=")) picks.push(a.slice("--project=".length));
  }
  return picks.length > 0 ? new Set(picks) : new Set(allNames);
}

export default async function globalSetupAll(config: FullConfig) {
  const selected = selectedProjects(config.projects.map((p) => p.name));
  if (selected.has("main")) await sharedSetup();
  if (selected.has("ask-user")) await askUserSetup();
  if (selected.has("permission-deny-ui")) await permissionDenyUiSetup();
  if (selected.has("autospawn")) await autospawnSetup();
}
