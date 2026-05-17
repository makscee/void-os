# vault

Seeded by `void-os init`. This directory is your void-os vault — the user-owned knowledge folder that the void-os daemon reads from and writes to on your behalf.

At seed, three files exist:

- `CLAUDE.md` — schema + agent system primer. Read this before editing anything by hand.
- `agents/tinker/agent.md` — the only starter agent. Talk to Tinker to create more.
- `log.md` — append-only timeline of agent activity. Starts empty.

Everything else (journal, tasks, milestones, wiki pages, additional agents) grows on demand through conversation with Tinker.

## First chat

```sh
void-os ask tinker "hello"
```

Or open this folder as an Obsidian vault and use the void-os plugin's chat pane.

## Git

This vault is a git repo. `void-os init` made the first `seed: void-os init` commit. If you opted into GitHub during install, it also created and pushed a private remote. Commit regularly — your vault is your operating record.

## Editing by hand

Anything Obsidian-editable is yours to change. Agent edits hot-reload on the next message — no restart needed. See `CLAUDE.md` for write-scope rules so you know which paths each agent owns.
