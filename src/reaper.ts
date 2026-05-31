// reaper.ts — idle Run reaper: kill + exit any 'idle' Run older than the TTL.
// Pure: tmux + clock injected, unit-testable without real tmux.
import type { Database } from "bun:sqlite";
import { setRunState } from "./registry.ts";

export interface TmuxLike {
  killSession(name: string): void;
}

/**
 * Kill + exit any 'idle' Run whose idle_since is older than ttlMs.
 * @param db     - the registry database
 * @param tmux   - tmux interface (real or stub)
 * @param nowMs  - current time in milliseconds
 * @param ttlMs  - idle TTL in milliseconds (idle_since <= nowMs - ttlMs → stale)
 */
export function reapIdleRuns(db: Database, tmux: TmuxLike, nowMs: number, ttlMs: number): void {
  const stale = db
    .query(
      "SELECT id, tmux_session FROM runs WHERE state = 'idle' AND idle_since IS NOT NULL AND idle_since <= ?",
    )
    .all(nowMs - ttlMs) as { id: string; tmux_session: string }[];
  for (const r of stale) {
    tmux.killSession(r.tmux_session);
    setRunState(db, r.id, "exited_ok", nowMs); // reaped cleanly
  }
}
