# vault/CLAUDE.md — shared context for void-os agents

This file is loaded by every Claude Code subprocess the void-os daemon spawns (CC walks up from `cwd = $VOID_OS_VAULT_ROOT`). Anything written here becomes baseline context for every agent in `agents/`. **Do not put per-agent persona or routing rules here** — those live in each agent's `agent.md`.

## What you are reading

You are running inside a void-os-managed vault. The vault is the user's primary knowledge folder (markdown notes, journal entries, task files, project pages). One agent per chat owns the conversation; you are that agent. Other agents are reachable via the `ask_agent(name, question)` MCP tool — stateless cross-agent Q&A, one shot, fresh context on the callee side.

At seed, only **Tinker** exists. Tinker is the meta/curator agent: it creates other agents, edits this file, and organises the wiki layer. Everything else in the vault is born through conversation, on demand.

## Wiki schema

The vault is an LLM-curated wiki. Structure is intentionally flat; categories emerge from use, not from a pre-baked taxonomy. Tinker owns reorganisation.

| Path | Contains | Who writes |
|---|---|---|
| `CLAUDE.md` | This file. Schema + agent system primer. | Tinker only |
| `index.md` | Catalog of pages (emerges on demand). | Tinker only |
| `log.md` | Date-grouped append-only timeline of all agent activity. | All agents (append) |
| `agents/<name>/agent.md` | Agent identity, scope, tools. | Tinker (or hand-edit in Obsidian) |
| `work/tasks/{backlog,active,completed,archive}/<ID>-<slug>.md` | Tickets. Folder = state; move with `git mv`. | Task-tracker / Kai |
| `work/milestones/<slug>.md` | Milestones. Flat; `status:` in frontmatter. | Atlas |
| `work/goals/<slug>.md` | Goals. Flat; `status:` in frontmatter. | Atlas |
| `journal/YYYY-MM-DD.md` | Daily journal. Append a `## Sessions` section per day. | Eva |
| `pages/<slug>.md` | Wiki pages (flat slug, no folders). `[[wikilinks]]` resolve. | Tinker promotes; agents draft |
| `sources/{papers,transcripts,clippings}/` | Raw immutable source material. | Hand-add |
| `.void/` | Daemon state. **Never agent-writable**, regardless of `write_scope`. | Daemon only |
| `.obsidian/` | Obsidian config. **Never agent-writable**. | Obsidian only |

Tasks are the only entity using folder-as-state. Milestones and goals stay flat and carry `status:` in frontmatter.

## Conventions

- **Dates are ISO 8601.** `2026-05-17`, never `May 17` or `17/05/2026`.
- **Append over rewrite.** When editing journal entries, task work logs, or `log.md`, append a new section rather than rewriting an existing one. Rewrites require `ask_user` confirmation.
- **Folder = state for tickets.** Move tickets between `backlog/`, `active/`, `completed/`, `archive/` via `git mv`. Never edit state in frontmatter.
- **Respect your `write_scope`.** Each agent's `agent.md` declares the paths it may write. Do not propose writes outside that list, even if the user asks — instead, `ask_agent` the appropriate specialist or explain the boundary.
- **`ask_user` for irreversible actions.** Anything that deletes data, rewrites an existing file (vs appending), pushes to a remote, or sends a message externally must be confirmed via `ask_user` first.
- **Page promotion threshold.** A fragment in `log.md` or a journal entry earns its own `pages/<slug>.md` after ~3 distinct references. Tinker performs the promotion.
- **Wikilinks for cross-reference.** Use `[[slug]]` (Obsidian convention) for inter-page references. Avoid relative paths in prose.

## Task frontmatter

```yaml
---
id: VOS-110
title: Bootstrap Tinker agent.md
parent: void-os-migration   # optional — milestone slug
---
```

Body: `## Why`, `## Done when`, `## Plan`, `## Log`. Active ID prefixes: `VOS`, `HMB`, `ADM`, `HUB`. New prefixes added as projects emerge.

## Agent system primer

An agent is a directory under `agents/<name>/` containing an `agent.md`. The frontmatter declares identity, scope, and tools; the body is the system prompt loaded into every chat with that agent. Edits hot-reload on the next message — no restart required.

Frontmatter fields:

| Field | Meaning |
|---|---|
| `name` | Agent slug (must match directory name). |
| `description` | One-line summary used by other agents when deciding whether to `ask_agent`. |
| `model` | CC model alias (`opus`, `sonnet`). |
| `version` | Semver-ish; bump on meaningful prompt revisions. |
| `cross_agent.ask` | Boolean. May this agent call `ask_agent`? |
| `cross_agent.handoff` | Boolean. May this agent transfer the chat to another? |
| `read_scope` | Glob list of paths this agent may read. Usually `['**']`. |
| `write_scope` | Glob list of paths this agent may write. Enforced by `VaultWriter`. |
| `skills` | Skill IDs auto-loaded for this agent. |
| `tools` | MCP tool names this agent may invoke. |

All writes go through the daemon's `VaultWriter` MCP tools (`vault.write`, `vault.append`, `vault.move`, `vault.delete`). The writer mutex serialises concurrent writes; `write_scope` is enforced server-side.

## `log.md` format

```markdown
## 2026-05-17
- 14:32 [eva] mood check: tired; captured "VOS-106 tomorrow"
- 15:01 [kai] started VOS-110
- 15:45 [tinker] promoted void-os-migration → pages/
```

All agents append. Tinker periodically summarises and prunes.

## Growing the system

Need a new capability? Tell Tinker: "create an agent that handles X." Tinker drafts `agents/<name>/agent.md`, you review it in Obsidian, iterate. Same for skills, wiki pages, schema changes. There is no big-bang setup — the vault grows the shape it needs.
