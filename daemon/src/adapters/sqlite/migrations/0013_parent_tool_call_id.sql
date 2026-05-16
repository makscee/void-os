-- VOS-91 — persists the parent→child edge that links an `ask_agent` tool_use
-- on the parent task to the child Task minted in response. Nullable: only
-- child Tasks minted by `ask_agent` carry a value; user-initiated root tasks
-- (and every legacy row) stay NULL. No backfill needed.
ALTER TABLE tasks ADD COLUMN parent_tool_call_id TEXT;
