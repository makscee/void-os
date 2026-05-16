# vault/CLAUDE.md — shared context for void-os agents

This file is loaded by every Claude Code subprocess the void-os daemon spawns (CC walks up from `cwd = $VOID_OS_VAULT_ROOT`). Anything written here becomes shared baseline context for every agent in `agents/`. **Do not put per-agent persona or routing rules here** — those live in each agent's `agent.md` body.

## What you are reading

You are running inside a void-os-managed vault. The vault is the user's primary knowledge folder (markdown notes, journal entries, task files, project notes). One agent per chat owns the conversation; you are that agent. Other agents are reachable via the `ask_agent(name, question)` MCP tool — stateless cross-agent Q&A, one shot, fresh context on the callee side. See `vault/projects/void-os/CONTEXT.md` §`ask_agent` for semantics.

## Vault layout

| Path | Contains |
|---|---|
| `agents/` | Agent definitions (`<name>/agent.md`). |
| `journal/` | Daily journal entries: `YYYY-MM-DD.md`. |
| `work/` | Tickets, milestones, goals, work plan. Folder = state. |
| `projects/` | Long-lived project context, design docs, archived plans. |
| `lessons/` | Cross-cutting lessons learned. |
| `infrastructure/` | Machine/service inventory and operational notes. |
| `standards/` | Locked specs (UI, frontend, etc.). |
| `_templates/` | Skeletons for new entries. |
| `.void/` | Daemon state — never agent-writable, regardless of `write_scope`. |
| `.obsidian/` | Obsidian config — never agent-writable. |

## Vocabulary recap

Canonical glossary: `vault/projects/void-os/CONTEXT.md`. Short aliases:

- **Vault** — `$VOID_OS_VAULT_ROOT`. Your read root.
- **Agent** — folder under `agents/<name>/` with an `agent.md`. Edits hot-reload on next message.
- **Chat** — long-lived CC session bound to one agent. A2A `Context`.
- **Task (A2A)** — stateful unit of work inside a Chat. Stays `WORKING` (or `INPUT_REQUIRED` when paused for `ask_user`) until the Chat ends.
- **Ticket** — project-management item under `vault/work/tasks/<state>/<ID>-<slug>.md`. ID = `<PFX>-<N>`. Distinct from A2A Task.
- **Turn** — one user input or agent reply inside a Task. A2A `Message`.
- **`ask_user(question, options?)`** — pauses your Task by flipping it to `INPUT_REQUIRED`; the user reply returns through the same tool call. One open question per Task at a time.
- **`ask_agent(name, question)`** — stateless cross-agent Q&A. Mints a child A2A Task in the same Context; the child has fresh context (no inherited history).

## Conventions

- **Dates are ISO 8601.** `2026-05-16`, never `May 16` or `16/05/2026`.
- **`ask_user` for irreversible actions.** Anything that deletes data, rewrites an existing file (vs appending), pushes to a remote, or sends a message externally must be confirmed via `ask_user` first.
- **Respect your `write_scope`.** Each agent's `agent.md` declares the paths it may write. Do not propose writes outside that list, even if the user asks — instead, `ask_agent` the appropriate specialist or explain the boundary.
- **Append over rewrite.** When editing journal entries or task work logs, prefer appending a new section to rewriting an existing one. Rewrites require `ask_user` confirmation.
- **Folder = state.** Tickets move between `backlog/`, `active/`, `completed/`, `archive/` via `git mv`. Never edit state in frontmatter.
