-- void-os:fk-rebuild
-- 0010_waiting_on_agent: extend tasks.state CHECK to include
-- TASK_STATE_WAITING_ON_AGENT (parent suspended on an ask_agent call) plus
-- the remaining A2A terminal states (COMPLETED, FAILED, CANCELED) the
-- handler in this milestone needs.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt via the
-- rename-rebuild-copy pattern (SQLite docs §"Making Other Kinds Of Table
-- Schema Changes", method 8a). The runner detects the
-- "void-os:fk-rebuild" marker on line 1 and toggles foreign_keys=OFF
-- outside the surrounding transaction (PRAGMA foreign_keys is a no-op
-- mid-tx). With FKs suspended, legacy_alter_table=ON keeps inbound FK
-- references (messages.task_id, runs.task_id, artifacts.task_id, plus the
-- self-ref parent_task_id) textually bound to "tasks" across the
-- rename — so when the new `tasks` is created they re-bind to it instead
-- of dangling against `tasks_old`. PRAGMA foreign_key_check is run by the
-- runner inside the tx to abort on any dangling reference.
--
-- Column list, FKs, defaults, and indexes mirror 0007_a2a_tables.sql
-- verbatim — only the state CHECK enum changes.
--
-- The migration runner wraps this file in a transaction; no in-file BEGIN/COMMIT.

PRAGMA legacy_alter_table = ON;

ALTER TABLE tasks RENAME TO tasks_old;

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  context_id      TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  parent_task_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  state           TEXT NOT NULL CHECK(state IN (
                    'TASK_STATE_UNSPECIFIED','TASK_STATE_SUBMITTED',
                    'TASK_STATE_WORKING','TASK_STATE_INPUT_REQUIRED',
                    'TASK_STATE_WAITING_ON_AGENT',
                    'TASK_STATE_COMPLETED','TASK_STATE_FAILED',
                    'TASK_STATE_CANCELED')),
  cost_usd        REAL NOT NULL DEFAULT 0,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

INSERT INTO tasks (
  id, context_id, parent_task_id, state,
  cost_usd, tokens_in, tokens_out, metadata,
  created_at, updated_at
)
SELECT
  id, context_id, parent_task_id, state,
  cost_usd, tokens_in, tokens_out, metadata,
  created_at, updated_at
FROM tasks_old;

DROP TABLE tasks_old;

CREATE INDEX idx_tasks_context ON tasks(context_id, created_at DESC);
CREATE INDEX idx_tasks_parent  ON tasks(parent_task_id);

PRAGMA legacy_alter_table = OFF;
