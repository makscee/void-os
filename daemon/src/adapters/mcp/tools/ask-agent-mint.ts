import type { Database } from "bun:sqlite";
import { AskAgentError } from "./ask-agent-errors";

export interface MintArgs {
  childId: string;
  contextId: string;
  parentId: string;
  targetAgent: string;
}

/**
 * Atomically mints a SUBMITTED child task and flips the parent task from
 * WORKING -> WAITING_ON_AGENT. Both writes happen in a single SQLite
 * transaction. If the CAS-flip of the parent fails (parent not in WORKING),
 * the transaction rolls back and the child INSERT is unwound, so no orphan
 * row is left behind.
 *
 * The child's target_agent column (added in migration 0011) names the agent
 * the dispatcher should run the child against; this is distinct from
 * contexts.agent_name (which the parent's context inherits).
 */
export function mintChildAndFlipParent(db: Database, a: MintArgs): void {
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.run(
      `INSERT INTO tasks
         (id, context_id, parent_task_id, state,
          cost_usd, tokens_in, tokens_out, metadata,
          created_at, updated_at, target_agent)
       VALUES (?, ?, ?, 'TASK_STATE_SUBMITTED',
               0, 0, 0, '{}', ?, ?, ?)`,
      [a.childId, a.contextId, a.parentId, now, now, a.targetAgent],
    );
    const res = db.run(
      `UPDATE tasks
         SET state = 'TASK_STATE_WAITING_ON_AGENT', updated_at = ?
       WHERE id = ? AND state = 'TASK_STATE_WORKING'`,
      [now, a.parentId],
    );
    if (res.changes === 0) {
      throw new AskAgentError("parent task not in WORKING state");
    }
  });
  tx();
}
