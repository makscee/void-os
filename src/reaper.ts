// reaper.ts — idle-reap: kill tmux sessions that have been idle too long.
// VOS-205: ADR-0003 amendment — reaper kills ONLY the tmux container; it does NOT
// revive warm-process/resume_token state (that stays removed per ADR-0003 §1).
// Resume-on-demand uses CC-native --resume (src/resume.ts).
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { listExecutions, setExecutionEnded } from "./registry.ts";
import { killSession } from "./tmux.ts";
import { sessionDir, reapedPath } from "./paths.ts";

export interface ReapCandidate {
  id: string;
  tmux_session: string;
  ended_at: number | null;
  last_activity: number;
}

/**
 * Pure: return the subset of live (ended_at==null) sessions whose
 * last_activity is at or older than now-idleMs.
 *
 * Injected clock (now, idleMs) keeps this 100% unit-testable without real time.
 */
export function dueForReap(execs: ReapCandidate[], now: number, idleMs: number): ReapCandidate[] {
  return execs.filter(e => e.ended_at == null && now - e.last_activity >= idleMs);
}

/**
 * Read the last-activity timestamp for an execution.
 *
 * Priority:
 *  1. last-activity.txt mtime — written by the /message route on each send-keys delivery.
 *  2. body.html mtime — updated whenever the REPL outputs; a reasonable proxy for activity.
 *  3. started_at — fallback when no files exist yet.
 *
 * File-stamp approach: schema-stable (no ALTER TABLE needed).
 */
function readLastActivity(vault: string, execId: string, startedAt: number): number {
  const dir = sessionDir(vault, execId);
  const stamp = join(dir, "last-activity.txt");
  if (existsSync(stamp)) {
    try { return statSync(stamp).mtimeMs; } catch { /* fallthrough */ }
  }
  const body = join(dir, "body.html");
  if (existsSync(body)) {
    try { return statSync(body).mtimeMs; } catch { /* fallthrough */ }
  }
  return startedAt;
}

/**
 * Sweep: kill the tmux session for each idle execution + mark the execution ended.
 * Returns the list of reaped execution IDs.
 *
 * killFn is injectable for testing (default: real killSession).
 */
export function reapIdle(
  db: Database,
  vault: string,
  now: number,
  idleMs: number,
  killFn: (session: string) => void = killSession,
): string[] {
  const rows = listExecutions(db).map(r => ({
    id: r.id,
    tmux_session: r.tmux_session,
    ended_at: r.ended_at,
    last_activity: readLastActivity(vault, r.id, r.started_at),
  }));
  const due = dueForReap(rows, now, idleMs);
  for (const d of due) {
    killFn(d.tmux_session);
    setExecutionEnded(db, d.id, now);
    // Stamp reaped.txt so deriveStatus can distinguish reaped-resumable from clean-complete (VOS-208).
    try { writeFileSync(reapedPath(vault, d.id), "reaped\n"); } catch { /* session dir may not exist in tests */ }
  }
  return due.map(d => d.id);
}
