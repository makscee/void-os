import type { Database } from "bun:sqlite";

export const MAX_ASK_AGENT_DEPTH = 5;

/**
 * Walks `tasks.parent_task_id` from the given task up to the root and returns
 * the depth (root = 0). Used by the ask_agent recursion guard to reject calls
 * that would exceed MAX_ASK_AGENT_DEPTH.
 */
export function askAgentChainDepth(db: Database, taskId: string): number {
  const row = db
    .query(
      `
    WITH RECURSIVE chain(id, parent, n) AS (
      SELECT id, parent_task_id, 0 FROM tasks WHERE id = ?
      UNION ALL
      SELECT t.id, t.parent_task_id, c.n + 1
      FROM tasks t JOIN chain c ON t.id = c.parent
    )
    SELECT MAX(n) AS depth FROM chain
  `,
    )
    .get(taskId) as { depth: number | null } | undefined;
  return row?.depth ?? 0;
}
