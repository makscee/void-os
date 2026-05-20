-- 0015_agents_rich_fields: add optional presentation columns to `agents`.
--
-- VOS-153 chat-screen agent-centric UX needs per-agent color, avatar
-- glyph, and tagline to render the chat header. These fields originate
-- in the agent.md frontmatter (read by scanVaultAgents) and travel through
-- AgentRow → sqlite → GET /agents → AgentListEntry to the plugin.
--
-- All three are nullable text columns — every existing agent row stays
-- valid (NULL serializes to undefined on the wire, so older agents simply
-- omit the new fields). No backfill needed; the next daemon boot's
-- scanVaultAgents().upsertAll(...) repopulates these columns from
-- frontmatter for vaults that ship them.

ALTER TABLE agents ADD COLUMN color   TEXT;
ALTER TABLE agents ADD COLUMN avatar  TEXT;
ALTER TABLE agents ADD COLUMN tagline TEXT;
