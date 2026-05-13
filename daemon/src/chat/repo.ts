// chatRepo — CRUD + list join + setSession helper.
// Per VOS-79 plan (2026-05-14-vos-79-chat-lifecycle-endpoints.md), Task 2.
//
// Schema notes:
//   - chats.created_at / updated_at are INTEGER epoch ms (0001_init.sql).
//   - chats.session_id and chats.current_run_id added by 0003_chat_lifecycle.sql.
//   - There is no session chain table; setSession writes the single sid
//     directly on chats. claudev --resume reuses the same sid across runs.

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

export interface ChatListItem {
  id: string;
  agent: string;
  title: string | null;
  last_msg: string | null;
  updated_at: number;
  last_run_status: string | null;
}

export interface ChatRepo {
  create(opts: { agent: string }): ChatRow;
  list(): ChatListItem[];
  get(id: string): ChatRow | null;
  setTitle(id: string, title: string): boolean;
  setLastMsg(id: string, lastMsg: string): void;
  setCurrentRun(id: string, runId: string | null): void;
  setSession(id: string, sessionId: string): void;
}

export function makeChatRepo(db: Database): ChatRepo {
  return {
    create({ agent }) {
      const id = randomUUID();
      const now = Date.now();
      db.run(
        "INSERT INTO chats (id, agent, title, created_at, updated_at, last_msg) VALUES (?,?,?,?,?,?)",
        [id, agent, null, now, now, null],
      );
      return db
        .query("SELECT * FROM chats WHERE id = ?")
        .get(id) as ChatRow;
    },
    list() {
      return db
        .query(
          `SELECT c.id, c.agent, c.title, c.last_msg, c.updated_at,
                  (SELECT r.status
                     FROM runs r
                    WHERE r.chat_id = c.id
                    ORDER BY r.started_at DESC
                    LIMIT 1) AS last_run_status
             FROM chats c
            ORDER BY c.updated_at DESC`,
        )
        .all() as ChatListItem[];
    },
    get(id) {
      return (
        (db.query("SELECT * FROM chats WHERE id = ?").get(id) as
          | ChatRow
          | null) ?? null
      );
    },
    setTitle(id, title) {
      const r = db.run(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND title IS NULL",
        [title, Date.now(), id],
      );
      return r.changes === 1;
    },
    setLastMsg(id, lastMsg) {
      db.run(
        "UPDATE chats SET last_msg = ?, updated_at = ? WHERE id = ?",
        [lastMsg, Date.now(), id],
      );
    },
    setCurrentRun(id, runId) {
      db.run("UPDATE chats SET current_run_id = ? WHERE id = ?", [runId, id]);
    },
    setSession(id, sessionId) {
      db.run(
        "UPDATE chats SET session_id = ?, updated_at = ? WHERE id = ?",
        [sessionId, Date.now(), id],
      );
    },
  };
}
