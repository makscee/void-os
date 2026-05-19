-- 0014_drop_maya_seed: remove the placeholder maya seed from 0008.
--
-- Background: 0008_agents_recreate seeded a default `maya` row so the
-- agent picker had a fallback option on a fresh install. But the seed
-- is a placeholder — it points at `agents/maya/agent.md`, a file that
-- doesn't exist in any starter vault (starter-vault/agents/ ships
-- `tinker/`, not `maya/`). On every boot, `scanVaultAgents` upserts
-- only the files it finds; the maya seed survives because upsertAll
-- never deletes missing entries.
--
-- Result: operators get a phantom "maya" agent in the picker that
-- resolves to `unknown agent: maya` at agent_cards lookup when they
-- try to use it. (Operator dogfood feedback 2026-05-19: "why do I
-- have maya agent? it's not in files".)
--
-- Fix: delete the seed iff it is still the un-touched placeholder
-- (vault_path = 'agents/maya/agent.md' AND updated_at = 0). If a
-- vault actually ships a maya/agent.md, `scanVaultAgents` will have
-- bumped updated_at to a real mtime via upsertAll's `ON CONFLICT`
-- branch, and this migration leaves it alone.

DELETE FROM agents
 WHERE name = 'maya'
   AND vault_path = 'agents/maya/agent.md'
   AND updated_at = 0;
