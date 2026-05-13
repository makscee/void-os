# void vault

This is your void vault — the file-tree control plane for void-os. Everything in it is plain markdown plus a sprinkle of metadata.

## Layout

- `CLAUDE.md` — system prompt the daemon loads for every agent in this vault.
- `agents/<name>/agent.md` — per-agent personality + model selection.
- `skills/<name>/SKILL.md` — reusable instructions agents follow when invoked.
- `.void/` — daemon state (SQLite, traces, logs). Gitignored.

## Operation

1. `brew services start void-os` — boots the daemon at `localhost:7777`.
2. `open <this folder>` — opens the vault in Obsidian. Enable community plugins when prompted to load the void-os plugin (when shipped).
3. Chat happens through the plugin (forthcoming) or directly via the daemon's HTTP / MCP surface.

## Where to look when something breaks

- Daemon logs: `~/Library/Logs/Homebrew/void-os/`
- Daemon state: `~/void/.void/state.sqlite` (one-line `sqlite3` inspection is enough)
- Architecture spec: `~/hub/vault/projects/void-os/specs/2026-05-13-void-os-v1-architecture.md`
