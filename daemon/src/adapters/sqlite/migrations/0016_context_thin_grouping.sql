-- void-os:fk-rebuild
-- 0016_context_thin_grouping (VOS-168): make Context a thin perpetual grouping
-- that holds MULTIPLE root Tasks. Move agent / session / current-run state off
-- `contexts` and onto `tasks`, where they belong (one Session per Task).
--
-- Before: `contexts` carried agent_name, session_id, current_run_id, updated_at,
-- archived. The daemon paired one Context 1:1 with a single root Task via
-- `openTaskFor` (the oldest parent_task_id IS NULL row).
--
-- After:
--   contexts  = id, title, created_at         (thin, perpetual, no lifecycle)
--   tasks     gains agent, session_id, current_run_id, last_event
--
-- `last_event` is an epoch-ms timestamp denormalised from the most recent
-- activity on the Task (message append / run terminal). It backs the activity
-- list ordering that `contexts.updated_at` used to provide.
--
-- The 1:1 constraint was never a DB constraint — it lived in daemon code. No
-- UNIQUE index is added: a Context may now hold N rows with
-- parent_task_id IS NULL.
--
-- SQLite cannot ALTER a CHECK constraint and cannot ADD a column referenced by
-- a backfill in the same simple ALTER, so `tasks` is rebuilt via the
-- rename-rebuild-copy pattern (SQLite docs §"Making Other Kinds Of Table
-- Schema Changes", method 8a). The "void-os:fk-rebuild" marker on line 1 makes
-- the runner toggle foreign_keys=OFF outside the surrounding transaction so the
-- inbound FK references (messages.task_id, runs.task_id, artifacts.task_id, and
-- the self-ref parent_task_id) re-bind to the new `tasks`.
--
-- The migration runner wraps this file in a transaction; no in-file BEGIN/COMMIT.

PRAGMA legacy_alter_table = ON;

-- 1. Rebuild `tasks` with the migrated agent / session / run columns.
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
  agent               TEXT,
  session_id          TEXT,
  current_run_id      TEXT REFERENCES runs(id),
  last_event          INTEGER,
  target_agent        TEXT,
  parent_tool_call_id TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Backfill. agent / session_id / current_run_id are pulled from the owning
-- Context (the old 1:1 home); last_event seeds from the Task's updated_at.
INSERT INTO tasks (
  id, context_id, parent_task_id, state,
  agent, session_id, current_run_id, last_event, target_agent, parent_tool_call_id,
  cost_usd, tokens_in, tokens_out, metadata,
  created_at, updated_at
)
SELECT
  t.id, t.context_id, t.parent_task_id, t.state,
  c.agent_name, c.session_id, c.current_run_id, t.updated_at, t.target_agent,
  t.parent_tool_call_id,
  t.cost_usd, t.tokens_in, t.tokens_out, t.metadata,
  t.created_at, t.updated_at
FROM tasks_old t
JOIN contexts c ON c.id = t.context_id;

DROP TABLE tasks_old;

CREATE INDEX idx_tasks_context    ON tasks(context_id, created_at DESC);
CREATE INDEX idx_tasks_parent     ON tasks(parent_task_id);
CREATE INDEX idx_tasks_last_event ON tasks(last_event DESC);

PRAGMA legacy_alter_table = OFF;

-- 2. Thin out `contexts`. DROP COLUMN (3.35.0+) leaves inbound FKs intact —
-- it does not rebuild the table. Must run with legacy_alter_table=OFF;
-- legacy mode does not support DROP COLUMN.
DROP INDEX IF EXISTS idx_contexts_updated;
DROP INDEX IF EXISTS chats_updated_at_idx;
DROP INDEX IF EXISTS chats_session_id_idx;
ALTER TABLE contexts DROP COLUMN agent_name;
ALTER TABLE contexts DROP COLUMN session_id;
ALTER TABLE contexts DROP COLUMN current_run_id;
ALTER TABLE contexts DROP COLUMN updated_at;
ALTER TABLE contexts DROP COLUMN archived;

-- 3. FK integrity check (aborts inside the runner's transaction on dangling
--    references).
PRAGMA foreign_key_check;
