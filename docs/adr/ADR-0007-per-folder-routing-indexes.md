# ADR-0007 — Per-folder CLAUDE.md indexes in starter-vault

- **Status:** Accepted
- **Date:** 2026-05-19
- **Resolves:** VOS-129
- **Related spec:** `vault/projects/void-os/specs/2026-05-17-benai-import-findings.md` §3.2

## Context

`starter-vault/` is seeded into every fresh vault by `void-os init`. Claude Code resolves project context by walking up from the `cwd` of the subprocess (here, `$VOID_OS_VAULT_ROOT`) and concatenating every `CLAUDE.md` it finds. At seed, only the root `starter-vault/CLAUDE.md` exists, so an agent invoked deep inside (e.g. `journal/2026-05-19.md`) sees only the global schema — no folder-local conventions for the substrate it is editing.

BenAI's F9 framework treats per-folder `CLAUDE.md` indexes as a hard architectural rule. void-os adopts the convention (not the enforcement layer — that belongs to a future vault-optimizer milestone).

## Decision

**Every meaningful folder in `starter-vault/` MUST ship a `CLAUDE.md` index.** A folder is "meaningful" when an agent or human is expected to navigate or write into it during normal use; throwaway technical dirs (`.void/`, `.obsidian/`) are exempt.

### Index shape

Each per-folder `CLAUDE.md` follows this template:

1. **One-line purpose.** What this folder is for.
2. **Conventions.** Naming, frontmatter, append-vs-rewrite rules, write-scope notes specific to the folder.
3. **Children.** One line per meaningful child (subdirectory or named file). Skip auto-generated noise.
4. **When an agent should care.** Concrete trigger conditions — when the walk-up to this file changes an agent's behaviour.

Target length: 30–60 lines. Lean over comprehensive — the root `CLAUDE.md` carries the global schema; per-folder indexes only add what is folder-local.

### Folders that ship `CLAUDE.md` at v1 seed

Current `starter-vault/` ships a deliberately minimal tree. The wiki schema (root `CLAUDE.md`) describes folders that emerge on demand; only folders that actually exist at seed get a `CLAUDE.md`.

| Folder | Ships at seed? | Index status |
|---|---|---|
| `starter-vault/` (root) | yes | existing `CLAUDE.md` — schema + agent primer |
| `agents/` | yes | **new in this ADR** |
| `agents/<name>/` | yes (only `tinker/` at seed) | **no** — `agent.md` is the system prompt; sibling `CLAUDE.md` would conflict with CC walk-up |
| `_templates/` | no at seed | scoped to VOS-131 (templates first-class) |
| `journal/` | no at seed | added by Tinker on first journal write (typically after Eva is created) |
| `pages/` | no at seed | added by Tinker on first page promotion |
| `work/tasks/`, `work/milestones/`, `work/goals/` | no at seed | added by Tinker/Kai/Atlas when first ticket/milestone/goal lands |
| `sources/` | no at seed | added on first source import |

### Convention for future folders

When an agent creates a new meaningful folder (e.g. Eva's first journal entry materialises `journal/`), the same agent — or Tinker on the next lint pass — drafts the folder's `CLAUDE.md` in the same shape. Tinker's lint mode (see `agents/tinker/agent.md` §3) gains a check for missing per-folder indexes in subsequent work.

This ADR is the contract; the lint rule is the enforcement (deferred to vault-optimizer milestone).

## Consequences

**Wins**
- Deep-folder Claude Code sessions get folder-local context on walk-up without rediscovery.
- Convention is mechanical: any agent (human or AI) creating a new folder knows the shape to drop in.
- Documentation cost stays bounded — 30–60 lines per folder, written once per folder.

**Costs**
- One more file to maintain when folder conventions change. Acceptable: folder conventions change rarely; the root `CLAUDE.md` still owns global schema.
- Risk of drift between root `CLAUDE.md` and per-folder `CLAUDE.md` if a global rule moves. Mitigation: per-folder files reference the root explicitly ("see vault root `CLAUDE.md` § X") rather than duplicating it.
- Tinker's lint rule for missing/stale folder indexes is not yet implemented. Accepted technical debt — flagged for vault-optimizer milestone.

## Implementation

- `starter-vault/agents/CLAUDE.md` — added in this task. See file for the canonical example of the index shape.
- `starter-vault/_templates/CLAUDE.md` — scope-shared with VOS-131. Lands when VOS-131's templates-first-class refactor materialises `_templates/`.
- Tinker's prompt: no edit required at v1. The lint-mode rule lands when the vault-optimizer milestone picks up enforcement.

## Smoke test (deferred)

The acceptance bullet "a Claude Code session opened in a deep folder of a freshly bootstrapped vault gets useful folder-level context on walk-up" cannot run in this sandbox (no Obsidian + CC session harness available). Operator-side verification:

1. From a freshly bootstrapped vault (`void-os init` into a scratch dir), `cd` into `starter-vault/agents/tinker/`.
2. Spawn a Claude Code session with `claude` CLI.
3. Confirm the loaded context includes both `starter-vault/CLAUDE.md` (root schema) and `starter-vault/agents/CLAUDE.md` (folder conventions) — but not a phantom `agents/tinker/CLAUDE.md` (which deliberately does not exist; the agent's own `agent.md` carries that prompt).
4. Ask the session "what file shape do I use to add a new agent here?" — answer should reflect the `agents/CLAUDE.md` conventions (one dir per agent, `.draft` suffix for new files, etc.).

Failure mode to watch for: if CC silently drops one of the per-folder `CLAUDE.md` files on walk-up (depth limit, file-size limit, or `.gitignore` interaction), the index is dead weight and the convention needs revisiting.
