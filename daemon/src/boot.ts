// VOS-79 T10: boot recovery.
//
// On daemon startup, any runs left in 'pending' or 'running' state are
// orphans from a previous crash / hard-kill: their process no longer
// exists, so they cannot terminate themselves. Flip them to 'interrupted'
// and clear any contexts.current_run_id pointer that referenced them, in a
// single transaction so the contexts table never lags behind runs.
// (Post-VOS-83: the `chats` table was renamed to `contexts` in migration 0007.)
//
// Silent by design: WebSocket clients are not connected this early, and
// the UI learns of the new state when it queries GET /chats (last_run_status).

import type { Database } from "bun:sqlite";

export function bootRecovery(
  db: Database,
  _emit?: (type: string, payload: unknown) => void,
): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.run(
      "UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status IN ('pending', 'running')",
      [now],
    );
    db.run(
      "UPDATE contexts SET current_run_id = NULL WHERE current_run_id IN (SELECT id FROM runs WHERE status = 'interrupted')",
    );
  });
  tx();
  // No emit by design — clients learn via GET /chats last_run_status.
}
