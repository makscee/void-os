-- 0012_costs_task_provider: add task_id + provider to costs.
-- VOS-87. Builds on 0007 (tasks table exists). Slot 0012 = next free
-- after 0011_tasks_target_agent.sql (0008/0010/0011 taken; 0009 gap left).
--
-- The runner wraps each file in a transaction; no in-file BEGIN/COMMIT.
-- No CHECK enum change means no rename-rebuild-copy required.

ALTER TABLE costs ADD COLUMN task_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE costs ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude-code';

CREATE INDEX idx_costs_task ON costs(task_id, ts);

PRAGMA foreign_key_check;
