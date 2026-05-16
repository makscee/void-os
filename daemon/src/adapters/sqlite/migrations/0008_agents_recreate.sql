-- 0008_agents_recreate: recreate the `agents` table dropped by 0007_a2a_tables.
--
-- Background: 0007 pivoted the daemon to A2A schema. It introduced
-- `agent_cards` (A2A card mirror) and dropped the legacy `agents` table.
-- However `daemon/src/agents/repo.ts` (AgentRepo) and `GET /agents` still
-- target the v1 `agents` shape from 0001_init.sql. Without this table,
-- daemon boot's `scanVaultAgents(...).upsertAll(...)` and the plugin's
-- agent picker (`GET /agents`) both fail with `no such table: agents`,
-- which blocks the ask_user e2e because the picker cannot mint a chat.
--
-- This migration recreates `agents` with the EXACT schema from 0001_init.sql
-- (name, description, model, vault_path, updated_at) so AgentRepo's prepared
-- statements (SELECT and INSERT...ON CONFLICT) keep working unchanged.
--
-- Seed default `maya` agent row. The plugin's "+ New" flow opens an agent
-- picker against GET /agents; if the list is empty the picker stalls on
-- "No agents in vault/agents/. Add an agent.md to get started." even though
-- POST /chats defaults `agent='maya'`. Seeding `maya` lets the picker
-- surface a default option on a fresh install (including hermetic e2e
-- fixtures whose vault has no agents/ directory).
--
-- daemon boot's `scanVaultAgents(vaultRoot).upsertAll(...)` will overwrite
-- this row if the vault contains a real maya/agent.md; absent that, the
-- seed remains intact (upsertAll never deletes — confirmed in agents/repo.ts).
-- vault_path is the conventional folder location; it is informational here
-- and not asserted by any caller (only the file scanner produces real paths).

CREATE TABLE agents (
  name         TEXT PRIMARY KEY,
  description  TEXT,
  model        TEXT,
  vault_path   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO agents (name, description, model, vault_path, updated_at)
VALUES ('maya', 'Default void-os agent.', 'opus', 'agents/maya/agent.md', 0);
