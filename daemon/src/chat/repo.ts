// chatRepo — CRUD + list join + setSession helper.
// Per VOS-79 plan (2026-05-14-vos-79-chat-lifecycle-endpoints.md), Task 2.
// Refactored by VOS-83 mig-0007 Task 4: pivoted from `chats` to `contexts`
// + mint a companion `tasks` row in the same transaction. The external
// `ChatRow` / `Chat` / `Context` shape is preserved (alias columns) so
// existing call-sites continue to compile. `last_msg` is no longer a
// column on `contexts` — it is derived from `messages.parts_text` (latest
// ROLE_AGENT row) via a correlated subquery in list().
//
// Schema notes (post 0016 — VOS-168):
//   - `contexts` is a thin perpetual grouping: id, title, created_at only.
//   - `agent`, `session_id`, `current_run_id` moved off `contexts` and onto
//     the `tasks` table (one Session per Task). A Context may hold N root
//     Tasks (parent_task_id IS NULL); the daemon still mints one root Task
//     per Context on create() and the legacy `ChatRow` surface projects
//     that root Task's agent/session/run for back-compat.
//   - `tasks.last_event` (epoch-ms) is a denormalised activity timestamp —
//     it backs the chat-list ordering that `contexts.updated_at` gave before.
//   - `openTaskFor` still resolves "the chat's root Task" — the oldest
//     parent_task_id IS NULL row for the context.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export interface ChatRow {
  id: string;
  agent: string;
  title: string | null;
  session_id: string | null;
  current_run_id: string | null;
  last_msg: string | null;
  created_at: number;
  updated_at: number;
}

// VOS-82: A2A vocabulary aliases. `Context` is the A2A-aligned name for
// what the daemon currently calls a Chat row (1 chat = 1 A2A context).
// `Chat` stays as the user-facing alias so existing call-sites continue
// to compile unchanged; downstream tickets migrate consumers off `Chat`.
export type Context = ChatRow;
/** @deprecated Use `Context` instead. Kept as an alias for backwards compatibility; downstream tickets will migrate. */
export type Chat = ChatRow;

// VOS-82: daemon-internal subprocess concept. NOT an A2A type — A2A
// models task lifecycle as a `Task` (see ./types/a2a.ts). `Run` represents
// the in-process spawn/cancel boundary; `task_id` is the optional link to
// an A2A Task when the run is dispatching against one (populated by
// downstream tickets that introduce Task tracking).
export interface Run {
  id: string;
  chat_id: string;
  agent: string;
  kind: string;
  status: string;
  started_at: number;
  ended_at?: number | null;
  task_id?: string;
}

export interface ChatListItem {
  id: string;
  agent: string;
  title: string | null;
  last_msg: string | null;
  updated_at: number;
  last_run_status: string | null;
  cost_usd: number;
  input_required: boolean;
  // VOS-110: context-window snapshot sourced from the latest `costs` row per
  // chat (ORDER BY ts DESC, id DESC LIMIT 1). All five are null when the
  // chat has no costs rows yet.
  context_tokens: number | null;
  context_input_tokens: number | null;
  context_output_tokens: number | null;
  context_cache_create_tokens: number | null;
  context_cache_read_tokens: number | null;
}

/** Result of context creation. Carries the minted open-task id so the
 *  orchestrator and HTTP layer can attribute the first user turn to it. */
export interface CreateChatResult extends ChatRow {
  /** id of the freshly minted `tasks` row (state='TASK_STATE_WORKING'). */
  task_id: string;
}

export interface ChatRepo {
  create(opts: { agent: string }): CreateChatResult;
  list(): ChatListItem[];
  get(id: string): ChatRow | null;
  setTitle(id: string, title: string): boolean;
  setLastMsg(id: string, lastMsg: string): void;
  setCurrentRun(id: string, runId: string | null): void;
  setSession(id: string, sessionId: string): void;
  /** Delete a chat (context) and its dependent rows. VOS-153: backs the
   *  plugin's Send-failure rollback by removing a freshly-minted chat when
   *  the first message fails. Returns true if a row was removed.
   *
   *  Defensively clears `messages` first (the FK has ON DELETE CASCADE,
   *  but `PRAGMA foreign_keys` is not asserted on at the test bootstrap
   *  layer, so we do not rely on cascade for the user-visible cleanup).
   *  `tasks` cascade is also covered by ON DELETE CASCADE on contexts.id. */
  delete(id: string): boolean;
}

/** Idempotent open-task lookup. Returns the oldest non-child task for a
 *  context. Throws if none exists (createChat always mints one — so a
 *  missing row indicates a stale row that pre-dates 0007 or a bug). */
export function openTaskFor(db: Database, contextId: string): string {
  const row = db
    .query(
      "SELECT id FROM tasks WHERE context_id = ? AND parent_task_id IS NULL ORDER BY created_at ASC LIMIT 1",
    )
    .get(contextId) as { id: string } | null;
  if (!row) throw new Error(`No open task for context ${contextId}`);
  return row.id;
}

/** Bump the root Task's `last_event` (epoch-ms) for a context. Post-0016 this
 *  is what powers chat-list recency ordering — it replaces the
 *  `contexts.updated_at` bump the 1:1 era used. No-op if the context has no
 *  root Task (should never happen — create() always mints one). */
export function touchRootTask(db: Database, contextId: string): void {
  const now = Date.now();
  db.run(
    `UPDATE tasks SET last_event = ?, updated_at = ?
       WHERE id = (
         SELECT id FROM tasks
          WHERE context_id = ? AND parent_task_id IS NULL
          ORDER BY created_at ASC LIMIT 1
       )`,
    [now, now, contextId],
  );
}

/** Flip `tasks.state` for the WORKING ↔ INPUT_REQUIRED handshake. Constrained
 *  to the two non-terminal states that the orchestrator legitimately toggles;
 *  terminal states (COMPLETED/FAILED/CANCELED) are NOT in the 0007 CHECK
 *  constraint and are written by downstream tickets that extend the enum. */
export function setTaskState(
  db: Database,
  taskId: string,
  state: "TASK_STATE_WORKING" | "TASK_STATE_INPUT_REQUIRED",
): void {
  db.run("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?", [
    state,
    Date.now(),
    taskId,
  ]);
}

export function makeChatRepo(db: Database): ChatRepo {
  return {
    create({ agent }) {
      const id = randomUUID();
      const taskId = randomUUID();
      const now = Date.now();
      const insertBoth = db.transaction(() => {
        // Context is thin (id/title/created_at); the root Task carries agent,
        // session, run state, and the `last_event` activity timestamp.
        db.run(
          "INSERT INTO contexts (id, title, created_at) VALUES (?,?,?)",
          [id, null, now],
        );
        db.run(
          "INSERT INTO tasks (id, context_id, state, agent, last_event, created_at, updated_at) VALUES (?, ?, 'TASK_STATE_WORKING', ?, ?, ?, ?)",
          [taskId, id, agent, now, now, now],
        );
      });
      insertBoth();
      const row = db
        .query(
          // Project the root Task's agent/session/run onto the legacy
          // `ChatRow` surface; `updated_at` is the root Task's last_event.
          `SELECT c.id, t.agent AS agent, c.title, t.session_id, t.current_run_id,
                  NULL AS last_msg, c.created_at,
                  COALESCE(t.last_event, c.created_at) AS updated_at
             FROM contexts c
             JOIN tasks t ON t.id = ?
            WHERE c.id = ?`,
        )
        .get(taskId, id) as ChatRow;
      return { ...row, task_id: taskId };
    },
    list() {
      // last_msg is derived from the most recent ROLE_AGENT message row
      // for the context (200-char preview shape preserved by the orchestrator
      // calling setLastMsg on terminal turns — which now upserts onto the
      // first 200 chars of parts_text; see setLastMsg).
      //
      // VOS-104: also surface lifetime SUM(costs.cost_usd) per chat and a
      // boolean flag indicating whether any task in the chat is currently in
      // TASK_STATE_INPUT_REQUIRED. SQLite returns an integer for the CASE
      // expression — coerce to a JS boolean at the boundary so the HTTP JSON
      // carries `true`/`false` rather than `0`/`1`.
      // VOS-110: surface the latest costs row per chat for the context-window
      // meter. Tiebreak on equal `ts` by highest `id` so a same-ts replay
      // deterministically picks the most-recently-inserted row.
      // `root` is the chat's root Task (oldest parent_task_id IS NULL row) —
      // it carries agent + the `last_event` activity timestamp the list is
      // ordered by. The 1:1 era stored these on the context; post-0016 the
      // chat-list view still projects the root Task.
      const rows = db
        .query(
          `SELECT c.id, root.agent AS agent, c.title,
                  (SELECT substr(m.parts_text, 1, 200)
                     FROM messages m
                    WHERE m.context_id = c.id AND m.role = 'ROLE_AGENT'
                      AND m.parts_text != ''
                    ORDER BY m.ts DESC, m.ord DESC
                    LIMIT 1) AS last_msg,
                  COALESCE(root.last_event, c.created_at) AS updated_at,
                  (SELECT r.status
                     FROM runs r
                    WHERE r.chat_id = c.id
                    ORDER BY r.started_at DESC
                    LIMIT 1) AS last_run_status,
                  COALESCE(
                    (SELECT SUM(cost_usd) FROM costs WHERE chat_id = c.id),
                    0
                  ) AS cost_usd,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM tasks
                     WHERE context_id = c.id
                       AND state = 'TASK_STATE_INPUT_REQUIRED'
                  ) THEN 1 ELSE 0 END AS input_required_int,
                  latest.input_tokens         AS context_input_tokens,
                  latest.output_tokens        AS context_output_tokens,
                  latest.cache_create_tokens  AS context_cache_create_tokens,
                  latest.cache_read_tokens    AS context_cache_read_tokens,
                  (latest.input_tokens
                   + latest.output_tokens
                   + latest.cache_create_tokens
                   + latest.cache_read_tokens) AS context_tokens
             FROM contexts c
             JOIN tasks root
               ON root.id = (
                    SELECT id FROM tasks
                     WHERE context_id = c.id AND parent_task_id IS NULL
                     ORDER BY created_at ASC
                     LIMIT 1
                  )
        LEFT JOIN costs latest
               ON latest.id = (
                    SELECT id FROM costs
                     WHERE chat_id = c.id
                     ORDER BY ts DESC, id DESC
                     LIMIT 1
                  )
            ORDER BY updated_at DESC`,
        )
        .all() as Array<
          Omit<
            ChatListItem,
            | "input_required"
            | "context_tokens"
            | "context_input_tokens"
            | "context_output_tokens"
            | "context_cache_create_tokens"
            | "context_cache_read_tokens"
          > & {
            input_required_int: 0 | 1;
            context_tokens: number | null;
            context_input_tokens: number | null;
            context_output_tokens: number | null;
            context_cache_create_tokens: number | null;
            context_cache_read_tokens: number | null;
          }
        >;
      return rows.map((r) => ({
        id: r.id,
        agent: r.agent,
        title: r.title,
        last_msg: r.last_msg,
        updated_at: r.updated_at,
        last_run_status: r.last_run_status,
        cost_usd: r.cost_usd,
        input_required: r.input_required_int === 1,
        context_tokens: r.context_tokens == null ? null : Number(r.context_tokens),
        context_input_tokens:
          r.context_input_tokens == null ? null : Number(r.context_input_tokens),
        context_output_tokens:
          r.context_output_tokens == null ? null : Number(r.context_output_tokens),
        context_cache_create_tokens:
          r.context_cache_create_tokens == null
            ? null
            : Number(r.context_cache_create_tokens),
        context_cache_read_tokens:
          r.context_cache_read_tokens == null
            ? null
            : Number(r.context_cache_read_tokens),
      }));
    },
    get(id) {
      // Project the root Task's agent/session/run onto the legacy ChatRow.
      return (
        (db
          .query(
            `SELECT c.id, root.agent AS agent, c.title,
                    root.session_id, root.current_run_id,
                    NULL AS last_msg, c.created_at,
                    COALESCE(root.last_event, c.created_at) AS updated_at
               FROM contexts c
               JOIN tasks root
                 ON root.id = (
                      SELECT id FROM tasks
                       WHERE context_id = c.id AND parent_task_id IS NULL
                       ORDER BY created_at ASC
                       LIMIT 1
                    )
              WHERE c.id = ?`,
          )
          .get(id) as ChatRow | null) ?? null
      );
    },
    setTitle(id, title) {
      const r = db.run(
        "UPDATE contexts SET title = ? WHERE id = ? AND title IS NULL",
        [title, id],
      );
      if (r.changes === 1) touchRootTask(db, id);
      return r.changes === 1;
    },
    setLastMsg(id, _lastMsg) {
      // last_msg column dropped in 0007; the preview text now comes from
      // messages.parts_text via the list() subquery. We only bump the root
      // Task's `last_event` so list ordering / "touched" semantics hold.
      touchRootTask(db, id);
    },
    setCurrentRun(id, runId) {
      // current_run_id moved off `contexts` onto the root Task (0016).
      db.run(
        `UPDATE tasks SET current_run_id = ?
           WHERE id = (
             SELECT id FROM tasks
              WHERE context_id = ? AND parent_task_id IS NULL
              ORDER BY created_at ASC LIMIT 1
           )`,
        [runId, id],
      );
    },
    setSession(id, sessionId) {
      // session_id moved off `contexts` onto the root Task (0016).
      const now = Date.now();
      db.run(
        `UPDATE tasks SET session_id = ?, last_event = ?, updated_at = ?
           WHERE id = (
             SELECT id FROM tasks
              WHERE context_id = ? AND parent_task_id IS NULL
              ORDER BY created_at ASC LIMIT 1
           )`,
        [sessionId, now, now, id],
      );
    },
    delete(id) {
      // Defensive cleanup so the delete works even when foreign_keys is OFF.
      // With foreign_keys=ON these would also cascade automatically.
      const tx = db.transaction(() => {
        db.run("DELETE FROM messages WHERE context_id = ?", [id]);
        db.run("DELETE FROM tasks WHERE context_id = ?", [id]);
        return db.run("DELETE FROM contexts WHERE id = ?", [id]);
      });
      const r = tx();
      return r.changes >= 1;
    },
  };
}
