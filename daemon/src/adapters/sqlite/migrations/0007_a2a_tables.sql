-- 0007_a2a_tables: pivot daemon SQLite from event-log shape to A2A schema-mirror.
-- See docs/superpowers/specs/2026-05-15-vos-83-mig-0007-a2a-design.md.
--
-- Verified 2026-05-15: chats.current_run_id present in 0003_chat_lifecycle.sql;
-- no inbound FKs into events/agents (safe to drop).
--
-- Dev-data wipe: this migration unconditionally DELETEs all rows in `messages`
-- and `chats` before reshape (PoC dev data, no preservation per locked spec).
-- A fresh DB on a new install applies cleanly; an existing dev DB loses chat
-- history.
--
-- SQLite version requirement: >= 3.35.0 (DROP COLUMN; asserted by migrations.ts).
-- The migration runner wraps this file in a transaction; no in-file BEGIN/COMMIT.
-- ALTER TABLE RENAME TO automatically rewrites foreign-key references in other
-- tables when legacy_alter_table=OFF (default since 3.25.0) — so renaming `chats`
-- -> `contexts` retargets `runs.chat_id` without a manual rebuild.

-- 1. Drop legacy surfaces.
DROP TABLE events;
DROP TABLE agents;

-- 2. Wipe + rename chats -> contexts (rewrites runs.chat_id FK automatically).
DELETE FROM messages;
DELETE FROM chats;

ALTER TABLE chats RENAME TO contexts;
ALTER TABLE contexts RENAME COLUMN agent TO agent_name;
ALTER TABLE contexts DROP COLUMN last_msg;
ALTER TABLE contexts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
DROP INDEX idx_chats_updated;
CREATE INDEX idx_contexts_updated ON contexts(updated_at DESC);

-- 3. Net-new A2A parent tables.
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  context_id      TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  parent_task_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  state           TEXT NOT NULL CHECK(state IN (
                    'TASK_STATE_UNSPECIFIED','TASK_STATE_SUBMITTED',
                    'TASK_STATE_WORKING','TASK_STATE_INPUT_REQUIRED')),
  cost_usd        REAL NOT NULL DEFAULT 0,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tasks_context ON tasks(context_id, created_at DESC);
CREATE INDEX idx_tasks_parent  ON tasks(parent_task_id);

CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name        TEXT,
  vault_path  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_task    ON artifacts(task_id);
CREATE INDEX idx_artifacts_created ON artifacts(created_at DESC);

CREATE TABLE agent_cards (
  agent_name    TEXT PRIMARY KEY,
  card_json     TEXT NOT NULL,
  source_mtime  INTEGER NOT NULL
);

-- 4. Recreate `messages` with A2A 2-role + JSON parts.
DROP TABLE messages;
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  context_id  TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  role        TEXT NOT NULL CHECK(role IN ('ROLE_USER','ROLE_AGENT')),
  parts       TEXT NOT NULL,
  parts_text  TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL,
  ord         INTEGER NOT NULL
);
CREATE INDEX idx_messages_task    ON messages(task_id, ts, ord);
CREATE INDEX idx_messages_context ON messages(context_id, ts, ord);
CREATE INDEX idx_messages_run     ON messages(run_id);

-- 5. Extend runs.
ALTER TABLE runs ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_runs_task ON runs(task_id);

-- 6. FK integrity check (aborts the migration inside the runner's transaction
--    if anything dangles).
PRAGMA foreign_key_check;
