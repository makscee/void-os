# ADR-0006 — Tinker writes drafts as `.draft` files (no `ask_user` for one-shot meta ops)

- Status: accepted
- Date: 2026-05-19
- Resolves: VOS-136

## Context

Tinker's PoC prompt instructed it to "show drafts before committing" — implemented via `ask_user`. This blocks `void-os ask tinker "..."` (one-shot, non-interactive): every meta op aborts with exit code 6 (`ask_user` while non-interactive) and pushes the user into `void-os chat`. VOS-122 acceptance bullet `void-os ask tinker "create eva, lean stub"` cannot pass under that design.

## Decision

Tinker writes drafts directly to a `.draft` sibling and exits successfully. The operator reviews the draft on disk (Obsidian, editor, or `cat`), then renames or asks Tinker to commit.

| | Old behavior | New behavior |
|---|---|---|
| Output of `ask tinker "create eva"` | exits 6 (needs `chat`) | writes `agents/eva/agent.md.draft`, exits 0 |
| Tinker tools | `ask_user` used for confirmation | `ask_user` still allowed but reserved for *destructive rewrites* (deletes, in-place schema rewrites) |
| Commit step | inline confirm | operator `mv agent.md.draft agent.md` OR asks Tinker "commit eva" |
| `void-os chat tinker` flow | unchanged (still streams) | unchanged — `chat` REPL renders the draft inline and lets the operator approve in-band |

## Consequences

**Wins**
- `ask tinker "..."` one-shot works for all meta ops that produce new files (the common case).
- No `chat`-mode tax on agent creation, page promotion, CLAUDE.md additions, lint reports.
- Draft files are a real artifact — the operator can diff, edit, abandon, or commit at their pace; no synchronous answer required.

**Costs**
- `.draft` files become a litter risk if Tinker writes a draft and the operator forgets it. Mitigation: `tinker lint` scans for stale `.draft` siblings older than 7 days.
- A "commit" verb requires a separate Tinker turn. Acceptable — most meta ops are one-shot creates, not edits.

## Implementation

- Update `starter-vault/agents/tinker/agent.md` § Conventions:
  - **Drafting an agent:** write to `agents/<name>/agent.md.draft`, append `log.md`, report draft path + suggested commit cmd. Do NOT `ask_user`.
  - **Editing `CLAUDE.md`, `index.md`, existing files in place:** still `ask_user` first — rewrites need explicit confirmation.
  - **Creating a new `pages/<slug>.md`:** write to `pages/<slug>.md.draft`. Same pattern.
- Lint module (existing Tinker mode 3): add stale-`.draft` scan rule.
- `VaultWriter` does not need changes — `.draft` already falls inside `agents/**` etc. globs.

## Alternatives considered

- **Option B — `void-os ask --auto-confirm`.** Rejected. Op-in dangerous flag for what should be the safe default; the draft-file design *is* the auto-confirm with the safety preserved (no destructive write).
- **Option C — keep current behavior, document `chat` requirement.** Rejected. Hostile UX. The CLI is the primary surface (per vault-migration design) and `ask` is the canonical entry for one-shot ops.

## References

- VOS-136 (this ADR's task)
- `starter-vault/agents/tinker/agent.md`
- Vault migration design: `hub/vault/projects/void-os-migration/specs/2026-05-16-vault-migration-design.md`
