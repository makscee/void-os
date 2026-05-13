-- 0003_chat_lifecycle: add session_id + current_run_id columns to chats.
-- Per VOS-79 plan (2026-05-14-vos-79-chat-lifecycle-endpoints.md).
--
-- T0 ground truth: claudev reuses one JSONL per (cwd, session_id) and
-- --resume appends to the same file with the same session_id. There is
-- no session chain — store the single sessionId directly on `chats`.
-- chat_sessions table was dropped from the design.
ALTER TABLE chats ADD COLUMN session_id     TEXT;
ALTER TABLE chats ADD COLUMN current_run_id TEXT REFERENCES runs(id);

CREATE INDEX IF NOT EXISTS chats_updated_at_idx ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS chats_session_id_idx ON chats(session_id);
