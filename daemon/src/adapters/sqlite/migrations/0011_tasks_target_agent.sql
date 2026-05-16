-- VOS-89: tasks.target_agent — when a child task is minted via ask_agent,
-- this column names the agent the dispatcher should run the child against.
-- NULL for tasks that inherit context.agent_name (i.e. every pre-VOS-89 task).
--
-- Simple ADD COLUMN. The runner wraps each file in a transaction; no in-file
-- BEGIN/COMMIT. No CHECK enum change means no rename-rebuild-copy required,
-- so no "void-os:fk-rebuild" marker.
ALTER TABLE tasks ADD COLUMN target_agent TEXT;
