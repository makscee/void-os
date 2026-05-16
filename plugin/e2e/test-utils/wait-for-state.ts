/**
 * Polls a row's `state` column from the daemon's sqlite DB until it matches
 * one of `expected`, or throws on timeout. Used by the ask_agent E2E spec
 * to assert state-machine transitions: parent WAITING_ON_AGENT -> child
 * COMPLETED -> parent COMPLETED.
 *
 * The daemon owns the DB writer; tests open a read-only connection.
 */
// Playwright runs under Node, not Bun, so we must use `node:sqlite`
// (Node >=22.5; available unflagged since v23). The daemon writer is Bun;
// they share the file via SQLite's WAL/locking — readonly here just means
// we promise not to write.
import { DatabaseSync } from "node:sqlite";

export interface WaitForStateOpts {
  dbPath: string;
  taskId: string;
  expected: string | string[];
  timeoutMs?: number;
  pollMs?: number;
}

export async function waitForTaskState(opts: WaitForStateOpts): Promise<string> {
  const { dbPath, taskId } = opts;
  const expected = new Set(
    Array.isArray(opts.expected) ? opts.expected : [opts.expected],
  );
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let last: string | undefined;
    while (Date.now() < deadline) {
      const row = db
        .prepare("SELECT state FROM tasks WHERE id = ?")
        .get(taskId) as { state: string } | undefined;
      if (row) {
        last = row.state;
        if (expected.has(row.state)) return row.state;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
      `waitForTaskState: timeout after ${timeoutMs}ms; taskId=${taskId} last=${last ?? "<missing>"} expected=${[...expected].join("|")}`,
    );
  } finally {
    db.close();
  }
}

/**
 * Poll until a row matching `predicate` is found in the tasks table for the
 * given `contextId`. Returns the row. Throws on timeout.
 */
export async function waitForTaskRow<T extends Record<string, unknown>>(opts: {
  dbPath: string;
  contextId: string;
  predicate: (row: TaskRow) => boolean;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<TaskRow> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  try {
    while (Date.now() < deadline) {
      const rows = db
        .prepare(
          "SELECT id, parent_task_id, context_id, state, target_agent FROM tasks WHERE context_id = ? ORDER BY created_at ASC",
        )
        .all(opts.contextId) as TaskRow[];
      const hit = rows.find(opts.predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
      `waitForTaskRow: timeout after ${timeoutMs}ms; contextId=${opts.contextId}`,
    );
  } finally {
    db.close();
  }
}

export interface TaskRow {
  id: string;
  parent_task_id: string | null;
  context_id: string;
  state: string;
  target_agent: string | null;
}
