# agents/ — agent definitions

One subdirectory per agent. Each `agents/<name>/agent.md` is the system prompt loaded into every chat with that agent; the frontmatter declares identity, scope, and tools. Edits hot-reload on the next message — no daemon restart needed.

See vault root `CLAUDE.md` § Agent system primer for frontmatter schema and `VaultWriter` write-scope enforcement.

## Conventions

- **One agent per directory.** Directory name MUST match the `name:` frontmatter field. Slug is lowercase, no spaces.
- **`agent.md` is the only required file.** Sidecar files (`README.md`, fixtures, notes) are allowed but agents do not auto-load them.
- **Drafts use `.draft` suffix.** Tinker writes new agents as `agents/<name>/agent.md.draft` for operator review; rename to commit. See `docs/adr/ADR-0006-tinker-draft-files-not-ask-user.md`.
- **`write_scope` is enforced server-side.** Declare the minimum path globs the agent needs. `read_scope: ['**']` is the default; narrow only when an agent must be blind to part of the vault.
- **No per-agent `CLAUDE.md` inside `agents/<name>/`.** The agent's `agent.md` body IS its system prompt — a sibling `CLAUDE.md` would conflict with CC's walk-up resolution. Folder-level context for the agent's *work surface* lives in that surface's folder (e.g. `journal/CLAUDE.md` describes the substrate Eva writes to, not Eva herself).

## Children

- `tinker/` — the seed meta-agent. Only agent that exists at `void-os init` time. Creates other agents, edits root `CLAUDE.md`, lints the vault. See `tinker/agent.md` for the full prompt.

## When an agent should care

- Reading or routing to another agent (`ask_agent` callees): scan sibling `agent.md` `description:` lines, not the body.
- Creating a new agent: Tinker drafts to `<name>/agent.md.draft`. See ADR-0006.
- Auditing capability surface: each `agent.md` frontmatter `tools:` list is the authoritative MCP allowlist for that agent.
