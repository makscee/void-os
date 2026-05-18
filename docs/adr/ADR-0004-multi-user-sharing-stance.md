# ADR-0004 — Multi-user vault sharing: deferred for v1

- **Status:** Accepted
- **Date:** 2026-05-18
- **Related spec:** `vault/projects/void-os/specs/2026-05-17-benai-import-findings.md` §3.5, §4

## Context

void-os v1 targets a single human operator working against a single vault on a single machine (with optional hub-wt worktrees for task isolation). The daemon, plugin chat surface, agent permissions, and `sw` state-write tooling all assume one identity behind every action — there is no notion of "actor" beyond "the operator."

BenAI ships the opposite assumption baked in: its `team-os` skill replaces the official Obsidian Relay plugin with a fork that adds RBAC for shared vaults, and its `os-mcp` skill deploys a Relay MCP server to the user's Railway account with OAuth 2.1 + PocketBase. That stack costs a hosted Postgres, an OAuth provider, a fork of an upstream plugin, and a non-trivial permission model.

The recurring question from contributors and drive-by reviewers is: *should void-os do that too?* Each time the question gets asked, the answer has to be re-derived from scratch — there is no durable record of where v1 stands or what would change the answer.

## Decision

**void-os v1 is single-user. Multi-user vault sharing is deferred, not refused.**

Concretely for v1:

- The daemon, plugin, and agent layer assume a single actor. No `user_id` plumbing, no per-actor permission rows, no RBAC table.
- No Relay fork is shipped or recommended. Users who want to share an Obsidian vault use the upstream Relay plugin at their own discretion, outside void-os's contract.
- No hosted multi-tenant deployment story. void-os runs on the operator's machine (or a single self-hosted host on their tailnet).
- Per-task isolation is handled by git worktrees (`~/void-os-wt/<ID>/`), not by per-actor scoping.

## Trigger to re-open

This ADR is superseded — replaced by a new ADR with an actual sharing design — when **the first paying void-os user explicitly requests vault sharing with at least one named collaborator**.

That trigger is deliberately specific:

- "Paying" rules out hypothetical interest from non-users.
- "First" means one is enough; this is not a market-research gate.
- "Explicitly requests … with at least one named collaborator" rules out vague "would be cool" feedback and forces a concrete shape (two real humans, one real vault, one real workflow).

When the trigger fires, the replacement ADR must answer: actor model (single shared vault vs federated), permission granularity (vault / folder / role-based via ADR-0004's role registry if shipped), transport (Relay fork vs first-party sync vs git-as-substrate), and identity (OAuth provider or local-only).

## Consequences

**Positive.**

- Drive-by "let's add multi-user" proposals land against this ADR rather than against fresh memory. Saves debate cycles.
- v1 architecture stays small: no permission model beyond agent `write_scope`, no actor plumbing through the daemon, no fork of Relay to maintain.
- The eventual sharing design gets to be informed by a real user's real workflow, not a speculative one.

**Negative.**

- void-os is not a "team" product in v1. Teams looking for a shared Obsidian-backed agent OS will pick BenAI or build their own.
- If/when the trigger fires, the retrofit cost is real — actor identity touches the daemon, the agent permission engine, and the plugin chat surface. This ADR does not pretend otherwise.

**Reversibility.** Fully reversible via a new ADR that supersedes this one. No code is being written against an irreversible assumption; the single-user posture is a *missing* feature, not a hostile one.

## See also

- ADR-0005 — BenAI features explicitly not adopted (covers the wider list, including the Relay fork at the implementation level)
- Spec: `vault/projects/void-os/specs/2026-05-17-benai-import-findings.md` §3.5 (origin of this ADR), §4 (sibling "not adopting" entries)
