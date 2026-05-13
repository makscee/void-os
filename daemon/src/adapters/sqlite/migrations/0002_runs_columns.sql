-- 0002_runs_columns: add CC-spawner lifecycle columns to runs.
-- Per VOS-73 design doc (2026-05-13-vos-73-cc-spawner-design.md).
ALTER TABLE runs ADD COLUMN session_id  TEXT;
ALTER TABLE runs ADD COLUMN exit_code   INTEGER;
ALTER TABLE runs ADD COLUMN kill_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
