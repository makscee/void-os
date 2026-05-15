// chatRepo — CRUD + list join + setSession helper.
// Per VOS-79 plan (2026-05-14-vos-79-chat-lifecycle-endpoints.md), Task 2.
// Refactored by VOS-83 mig-0007 Task 4: pivoted from `chats` to `contexts`
// + mint a companion `tasks` row in the same transaction. The external
// `ChatRow` / `Chat` / `Context` shape is preserved (alias columns) so
// existing call-sites continue to compile. `last_msg` is no longer a
// column on `contexts` — it is derived from `messages.parts_text` (latest
// ROLE_AGENT row) via a correlated subquery in list().
//
// Schema notes (post 0007):
//   - chats → contexts (renamed by 0007).
//   - contexts.agent_name replaces chats.agent.
//   - contexts.last_msg dropped; derive on read.
//   - tasks row is minted on context creation with state='TASK_STATE_WORKING'.

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
        db.run(
          "INSERT INTO contexts (id, agent_name, title, created_at, updated_at) VALUES (?,?,?,?,?)",
          [id, agent, null, now, now],
        );
        db.run(
          "INSERT INTO tasks (id, context_id, state, created_at, updated_at) VALUES (?, ?, 'TASK_STATE_WORKING', ?, ?)",
          [taskId, id, now, now],
        );
      });
      insertBoth();
      const row = db
        .query(
          // Surface `agent` alias for back-compat with downstream consumers
          // and inject a NULL last_msg for the same reason.
          "SELECT id, agent_name AS agent, title, session_id, current_run_id, NULL AS last_msg, created_at, updated_at FROM contexts WHERE id = ?",
        )
        .get(id) as ChatRow;
      return { ...row, task_id: taskId };
    },
    list() {
      // last_msg is derived from the most recent ROLE_AGENT message row
      // for the context (200-char preview shape preserved by the orchestrator
      // calling setLastMsg on terminal turns — which now upserts onto the
      // first 200 chars of parts_text; see setLastMsg).
      return db
        .query(
          `SELECT c.id, c.agent_name AS agent, c.title,
                  (SELECT substr(m.parts_text, 1, 200)
                     FROM messages m
                    WHERE m.context_id = c.id AND m.role = 'ROLE_AGENT'
                    ORDER BY m.ts DESC, m.ord DESC
                    LIMIT 1) AS last_msg,
                  c.updated_at,
                  (SELECT r.status
                     FROM runs r
                    WHERE r.chat_id = c.id
                    ORDER BY r.started_at DESC
                    LIMIT 1) AS last_run_status
             FROM contexts c
            ORDER BY c.updated_at DESC`,
        )
        .all() as ChatListItem[];
    },
    get(id) {
      return (
        (db
          .query(
            "SELECT id, agent_name AS agent, title, session_id, current_run_id, NULL AS last_msg, created_at, updated_at FROM contexts WHERE id = ?",
          )
          .get(id) as ChatRow | null) ?? null
      );
    },
    setTitle(id, title) {
      const r = db.run(
        "UPDATE contexts SET title = ?, updated_at = ? WHERE id = ? AND title IS NULL",
        [title, Date.now(), id],
      );
      return r.changes === 1;
    },
    setLastMsg(id, _lastMsg) {
      // last_msg column dropped in 0007. We only bump updated_at so list
      // ordering and "touched" semantics stay intact. The actual preview
      // text now comes from messages.parts_text via the list() subquery.
      db.run("UPDATE contexts SET updated_at = ? WHERE id = ?", [
        Date.now(),
        id,
      ]);
    },
    setCurrentRun(id, runId) {
      db.run("UPDATE contexts SET current_run_id = ? WHERE id = ?", [
        runId,
        id,
      ]);
    },
    setSession(id, sessionId) {
      db.run(
        "UPDATE contexts SET session_id = ?, updated_at = ? WHERE id = ?",
        [sessionId, Date.now(), id],
      );
    },
  };
}
