// VOS-166: runtime agent rescan.
//
// The daemon scans vault/agents/ once at boot (index.ts). An agent.md
// authored *after* boot was invisible to GET /agents until a restart —
// caught by the VOS-163 operator-journey e2e (stage S4).
//
// This module re-runs the same boot-time scan (agents table + agent_cards)
// on demand. `makeDebouncedRescan` wraps it so the agent rail polling
// GET /agents does not hammer the filesystem: the scan runs at most once
// per `intervalMs` window; calls inside the window reuse the last result.
//
// Lazy rescan-on-read is preferred over an fs.watch watcher: no watcher
// lifecycle to manage, no platform-specific fs.watch quirks (recursive
// watch is unsupported on Linux), and it naturally covers agent *deletion*
// + frontmatter edits, not just creation.

import type { Database } from "bun:sqlite";
import { scanVaultAgents } from "./scan.ts";
import { makeAgentRepo } from "./repo.ts";
import { scanAgentCards, upsertAgentCards } from "./cards-scan.ts";

/**
 * Re-scan vault/agents/ and mirror into the `agents` table and `agent_cards`.
 * Mirrors the boot-time logic in index.ts. Never throws — a scan failure
 * leaves the existing rows in place and is logged.
 */
export function rescanAgents(db: Database, vaultRoot: string): void {
  try {
    const agentRows = scanVaultAgents(vaultRoot);
    makeAgentRepo(db).upsertAll(agentRows);
  } catch (e) {
    console.warn(
      `agents/rescan: agents scan failed: ${e instanceof Error ? e.message : e} — keeping existing rows`,
    );
  }
  try {
    const cards = scanAgentCards(vaultRoot);
    upsertAgentCards(db, cards);
  } catch (e) {
    console.warn(
      `agents/rescan: agent_cards scan failed: ${e instanceof Error ? e.message : e} — keeping existing rows`,
    );
  }
}

/**
 * Wrap `rescanAgents` with a time-window debounce. The returned function
 * runs the scan only if at least `intervalMs` has elapsed since the last
 * scan; otherwise it is a no-op. Default window: 1000 ms.
 */
export function makeDebouncedRescan(
  db: Database,
  vaultRoot: string,
  intervalMs = 1000,
): () => void {
  let lastScan = 0;
  return () => {
    const now = Date.now();
    if (now - lastScan < intervalMs) return;
    lastScan = now;
    rescanAgents(db, vaultRoot);
  };
}
