// VOS-169: navigation query layer over the perpetual tree of Tasks.
//
// The plugin renders one chat at a time; this module gives the managing agent
// and the UI the *same* read-only primitives to walk the tree globally:
//
//   - listTasks(opts?)  — every Task across every Context, sorted by activity.
//   - listChildren(id)  — direct children of a Task.
//   - getTask(id)       — one Task with its message history.
//
// These are plain queries over the `tasks` table (post-0016 thin-Context
// schema: `tasks` carries agent / session_id / current_run_id / last_event;
// `contexts` is thin id/title/created_at). Navigation is NOT a bespoke API —
// it is just queries, so the agent and the UI never drift.

import type { Database } from "bun:sqlite";
import { makeMessagesRepo } from "./messages-repo";
import type { ReplayEntry } from "./session-replay";

/** A2A terminal states. A Task in one of these has finished and ages out of
 *  the default `listTasks` view. TASK_STATE_REJECTED is included defensively:
 *  the 0016 CHECK enum does not define it yet, but treating it as terminal
 *  here means a future migration that adds it needs no change to this code. */
export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

/** Default recency window for terminal Tasks: a terminal Task stays in the
 *  default `listTasks` view for this long after its last activity, then ages
 *  out. Non-terminal Tasks are never aged out. */
export const DEFAULT_TERMINAL_RECENCY_MS = 24 * 60 * 60 * 1000; // 24h

/** One row of the global activity list. `title` is the owning Context's title
 *  (perpetual grouping); `last_event` is the denormalised activity timestamp
 *  that backs the recency sort. */
export interface TaskListItem {
  id: string;
  context_id: string;
  context_title: string | null;
  parent_task_id: string | null;
  agent: string | null;
  state: string;
  last_event: number | null;
  created_at: number;
  updated_at: number;
}

/** A full Task row plus its message history (ADR-0010: a Task's output is its
 *  final message; history must be individually addressable). */
export interface TaskDetail extends TaskListItem {
  session_id: string | null;
  current_run_id: string | null;
  target_agent: string | null;
  parent_tool_call_id: string | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  metadata: string;
  messages: ReplayEntry[];
}

export interface ListTasksOpts {
  /** Include terminal Tasks regardless of recency. Default false. */
  includeTerminal?: boolean;
  /** Recency window (ms) for terminal Tasks. Terminal Tasks whose `last_event`
   *  is within `now - recencyMs` still appear. Ignored when `includeTerminal`
   *  is true. Default DEFAULT_TERMINAL_RECENCY_MS. */
  recencyMs?: number;
  /** Cap the number of rows returned. Default unbounded. */
  limit?: number;
  /** Clock injection for deterministic recency tests. Default Date.now. */
  now?: () => number;
}

export interface NavRepo {
  listTasks(opts?: ListTasksOpts): TaskListItem[];
  listChildren(taskId: string): TaskListItem[];
  getTask(taskId: string): TaskDetail | null;
}

// Shared SELECT projection for the list-item shape. `c.title` is the owning
// Context's title; LEFT JOIN keeps a Task visible even if its Context row is
// somehow missing (should not happen — FK enforces it).
const LIST_ITEM_SELECT = `
  SELECT t.id, t.context_id, c.title AS context_title,
         t.parent_task_id, t.agent, t.state, t.last_event,
         t.created_at, t.updated_at
    FROM tasks t
    LEFT JOIN contexts c ON c.id = t.context_id
`;

interface RawListRow {
  id: string;
  context_id: string;
  context_title: string | null;
  parent_task_id: string | null;
  agent: string | null;
  state: string;
  last_event: number | null;
  created_at: number;
  updated_at: number;
}

const toListItem = (r: RawListRow): TaskListItem => ({
  id: r.id,
  context_id: r.context_id,
  context_title: r.context_title,
  parent_task_id: r.parent_task_id,
  agent: r.agent,
  state: r.state,
  last_event: r.last_event,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export function makeNavRepo(db: Database): NavRepo {
  const messages = makeMessagesRepo(db);

  return {
    listTasks(opts) {
      const includeTerminal = opts?.includeTerminal ?? false;
      const recencyMs = opts?.recencyMs ?? DEFAULT_TERMINAL_RECENCY_MS;
      const now = (opts?.now ?? Date.now)();
      const limit = opts?.limit;

      // Sort key: COALESCE(last_event, created_at) so a Task that has not yet
      // recorded an event still sorts by its mint time. DESC = most recent
      // activity first.
      let sql = `${LIST_ITEM_SELECT} ORDER BY COALESCE(t.last_event, t.created_at) DESC`;
      const rows = db.query(sql).all() as RawListRow[];

      // Terminal age-out is applied in JS rather than SQL: the terminal set is
      // a JS constant (TERMINAL_TASK_STATES) so a single source of truth backs
      // both the filter and any future consumer, and REJECTED is filterable
      // even though the DB CHECK enum does not list it.
      const cutoff = now - recencyMs;
      const filtered = includeTerminal
        ? rows
        : rows.filter((r) => {
            if (!TERMINAL_TASK_STATES.has(r.state)) return true;
            const activity = r.last_event ?? r.created_at;
            return activity >= cutoff;
          });

      const capped =
        typeof limit === "number" && limit >= 0
          ? filtered.slice(0, limit)
          : filtered;
      return capped.map(toListItem);
    },

    listChildren(taskId) {
      // Direct children only — one level of `parent_task_id`. Oldest first so
      // the tree reads top-to-bottom in mint order.
      const rows = db
        .query(
          `${LIST_ITEM_SELECT} WHERE t.parent_task_id = ? ORDER BY t.created_at ASC`,
        )
        .all(taskId) as RawListRow[];
      return rows.map(toListItem);
    },

    getTask(taskId) {
      const row = db
        .query(
          `SELECT t.id, t.context_id, c.title AS context_title,
                  t.parent_task_id, t.agent, t.state, t.last_event,
                  t.session_id, t.current_run_id, t.target_agent,
                  t.parent_tool_call_id, t.cost_usd, t.tokens_in, t.tokens_out,
                  t.metadata, t.created_at, t.updated_at
             FROM tasks t
             LEFT JOIN contexts c ON c.id = t.context_id
            WHERE t.id = ?`,
        )
        .get(taskId) as
        | (RawListRow & {
            session_id: string | null;
            current_run_id: string | null;
            target_agent: string | null;
            parent_tool_call_id: string | null;
            cost_usd: number;
            tokens_in: number;
            tokens_out: number;
            metadata: string;
          })
        | null;
      if (!row) return null;

      // Message history scoped to THIS Task (messages.task_id), not the whole
      // Context. messagesRepo.walk() keys on context_id, so we filter its
      // output by task_id — every ReplayEntry already carries task_id.
      const allEntries = messages.walk(row.context_id);
      const taskMessages = allEntries.filter((e) => e.task_id === taskId);

      return {
        id: row.id,
        context_id: row.context_id,
        context_title: row.context_title,
        parent_task_id: row.parent_task_id,
        agent: row.agent,
        state: row.state,
        last_event: row.last_event,
        session_id: row.session_id,
        current_run_id: row.current_run_id,
        target_agent: row.target_agent,
        parent_tool_call_id: row.parent_tool_call_id,
        cost_usd: row.cost_usd,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
        messages: taskMessages,
      };
    },
  };
}
