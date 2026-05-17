/**
 * VOS-107 T9: chained globalTeardown — mirrors globalSetup-all.ts. Tears
 * down both the shared and the ask-user-isolated daemons. Each teardown
 * is wrapped in try/catch so a failure in one doesn't leak the other.
 */
import type { FullConfig } from "@playwright/test";
import sharedTeardown from "./globalTeardown.ts";
import askUserTeardown from "./globalTeardown-ask-user.ts";
import autospawnTeardown from "./globalTeardown-autospawn.ts";

// Mirror of globalSetup-all selection: parse --project from argv (FullConfig
// gives the declared list, not the filter).
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

export default async function globalTeardownAll(config: FullConfig) {
  const selected = selectedProjects(config.projects.map((p) => p.name));
  // Tear down in reverse setup order.
  if (selected.has("autospawn")) {
    try { await autospawnTeardown(); } catch (err) { console.error("[teardown] autospawn:", err); }
  }
  if (selected.has("ask-user")) {
    try { await askUserTeardown(); } catch (err) { console.error("[teardown] ask-user:", err); }
  }
  if (selected.has("main")) {
    try { await sharedTeardown(); } catch (err) { console.error("[teardown] shared:", err); }
  }
}
