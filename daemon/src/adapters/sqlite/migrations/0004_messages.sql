-- 0004_messages: canonical messages table.
-- Per VOS-80 architecture (a): daemon DB replaces CC's filesystem JSONL as
-- the source of truth for GET /chat/:id/messages. Killed/cancelled turns
-- whose partial text never reached CC's JSONL still surface in replay
-- because the orchestrator persists tokens here on cancel/error before
-- run.end.
--
-- Schema rationale:
--   - role discriminates the ReplayEntry union (text turn vs tool block).
--   - content is a text catchall: user/assistant=text; tool_use=JSON.stringify(input);
--     tool_result=normalized output text. Per-role rendering owns parsing.
--   - run_id is nullable to keep history readable after a run row is deleted
--     (ON DELETE SET NULL) and to allow seeded rows from legacy JSONL imports
--     whose run is no longer represented in `runs`.
--   - ord is a per-insert monotonically increasing counter scoped to chat_id;
--     ts alone is not unique enough (multiple tool_use blocks within one
--     assistant turn share a ts).
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  role          TEXT NOT NULL CHECK(role IN ('user','assistant','tool_use','tool_result')),
  content       TEXT,
  tool_call_id  TEXT,
  tool_name     TEXT,
  is_error      INTEGER NOT NULL DEFAULT 0,
  ts            INTEGER NOT NULL,
  ord           INTEGER NOT NULL
);

CREATE INDEX idx_messages_chat_ts ON messages(chat_id, ts, ord);
CREATE INDEX idx_messages_chat_run ON messages(chat_id, run_id);
