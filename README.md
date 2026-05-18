# void-os

Agent OS: a local daemon plus Obsidian plugin that turns an Obsidian vault into the control plane for Claude Code workflows. The daemon orchestrates task state, agent runs, and vault writes; the plugin surfaces tasks, plans, and logs inside Obsidian.

See also: `hub/vault/projects/void-os/specs/2026-05-13-void-os-v1-architecture.md` for the v1 architecture spec.

---

## 1. What is void-os

void-os is a daemon + CLI + Obsidian plugin that turns an Obsidian vault into a multi-agent environment backed by Claude Code subprocesses. Each agent has scoped read/write access to the vault, a declared toolset, and runs as an isolated Claude Code session. The daemon manages chat state, dispatches runs, streams events to clients (CLI + plugin), and writes back into the vault under guard.

Tinker is the seed agent — a meta / curator role who helps you bootstrap the rest of your fleet. Typical specialists you might grow from Tinker: Eva (journaling), Atlas (goals), Kai (tasks), Warden (ops), Maya (dispatch). The plugin and CLI speak to the same daemon, so a conversation started in Obsidian is the same conversation `void-os ask` and `void-os chat` see.

## 2. Prerequisites

### Mac
- macOS 13+ (Apple Silicon or Intel)
- bun >= 1.3 — install via `curl -fsSL https://bun.sh/install | bash`
- `claudev` on PATH — void-os spawns Claude Code subprocesses via the `claudev` wrapper. The binary name is hard-coded; confirm with `which claudev`. (There is no `VOID_OS_CC_BIN` env var yet — `claudev` must be on PATH of whatever shell starts the daemon.)
- Anthropic API access — `claudev` handles auth for spawned CC sessions.
- Optional: `gh` CLI authed, if you want `void-os init` to create a private GitHub repo for your vault.

### Linux / LXC
- Ubuntu 22.04+ or Debian 12+
- `apt install -y curl git build-essential`
- bun via the same `curl -fsSL https://bun.sh/install | bash`
- `claudev` on PATH (same as Mac)

## 3. Mac install (the verified path)

```sh
# 1. Clone
git clone https://github.com/makscee/void-os.git ~/scratch/void-os
cd ~/scratch/void-os

# 2. Install deps
bun install

# 3. Register CLI globally
bun link
# void-os is now on PATH at ~/.bun/bin/void-os
# Make sure ~/.bun/bin is on your PATH (most bun installers do this).

# 4. Seed a vault (interactive — accept defaults with Enter)
void-os init
# Prompts: vault location (default ~/vault), GitHub push, Obsidian vault name.
# init will: copy starter-vault content into ~/vault, build the Obsidian plugin,
# install it into <vault>/.obsidian/plugins/void-os, and auto-start the daemon.

# 5. Verify
void-os daemon status      # running + your vault path
void-os ask tinker "hi"    # one-line greeting from Tinker
```

## 4. Linux / LXC install (non-interactive)

```sh
git clone https://github.com/makscee/void-os.git /opt/void-os
cd /opt/void-os
bun install && bun link
void-os init --non-interactive --vault $HOME/vault --skip-gh
void-os daemon status
void-os ask tinker "hi"
```

Notes:
- `--skip-gh` skips remote repo creation. Drop it (and ensure `gh auth status` is green) if you want `init` to create a private GitHub repo for the vault.
- `--non-interactive` requires `--vault <path>` — `init` refuses to guess.
- Other useful flags: `--force` (overwrite a non-void dir or re-seed), `--dry-run` (print actions, write nothing), `--skip-build` (dev-loop iteration), `--skip-obsidian` (don't install the plugin), `--gh-repo <name>` (explicit repo name).

## 5. Open the vault in Obsidian

1. Obsidian → File → Open vault → choose `~/vault` (or wherever you seeded).
2. Obsidian will ask you to trust the vault author — accept.
3. Settings → Community plugins → Enable "void-os".
4. Open the void-os chat pane (left sidebar icon, or command palette: "void-os: open chat").
5. Click Tinker to start a chat.

The plugin and the CLI both talk to the same daemon on `127.0.0.1:7777`, so plugin chats, `void-os ask`, and `void-os chat` share state.

## 6. Daily use

- One-shot CLI: `void-os ask <agent> "<message>"` — buffered until run_end (add `--stream` to flush text as it arrives).
- Interactive REPL: `void-os chat <agent>` — type `exit`, `/exit`, or Ctrl-D to leave. Ctrl-C cancels the active run; a second Ctrl-C while idle exits 130.
- Plugin chat: same conversations, in Obsidian.
- Tinker drafts new agents: ask "create eva to handle my journal" and Tinker will draft `agents/eva/agent.md` for your review.
- Daemon: `void-os daemon {start|stop|status|logs}`. `logs` supports `--tail N` and `-f`/`--follow`.
- List agents: `void-os agents list`.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `void-os: command not found` after `bun link` | `~/.bun/bin` not on PATH | add `export PATH="$HOME/.bun/bin:$PATH"` to your shell rc |
| `void-os ask` errors `Executable not found in $PATH: "claudev"` | CC wrapper not on PATH for the daemon process | make sure `claudev` is on PATH **before** `void-os daemon start`; stop + restart the daemon after fixing PATH |
| daemon errors with `EADDRINUSE: port 7777` | another vault's daemon is already running | `void-os daemon stop` first, then start for your target vault |
| `init` says "plugin build artifact missing" | fresh clone without `bun install` | re-run `bun install`, then `void-os init` |
| Obsidian doesn't show void-os under Community plugins | plugin install step didn't seed | check `<vault>/.obsidian/plugins/void-os/manifest.json` exists; if not, from the repo root run `( cd plugin && VOID_OS_PLUGIN_OUT="$PWD/dist" bun run build )` then re-run `void-os init` |
| `void-os ask` exits 7 with `error: ...` | Run errored — the message tells you what; common: model called a tool the agent doesn't have | follow the error; for interactive flows, switch to `void-os chat` |
| `void-os ask` exits 6 saying "agent asked for input; this requires interactive mode" | agent invoked `ask_user` mid-run, which `ask` can't satisfy | re-run with `void-os chat <agent>` |
| `void-os ask` exits 4 saying "agent '<name>' not found" | agent not registered in vault | `void-os agents list` to see what's there; ask Tinker to draft the missing agent |
| `void-os ask` exits 5 saying "vault not configured" | `VOID_OS_VAULT_ROOT` unset and `~/Library/Application Support/void-os/vault` missing | run `void-os init`, or `export VOID_OS_VAULT_ROOT=<path>` before `daemon start` |
| `void-os ask` exits 3 saying "daemon not running" | daemon down or unreachable | `void-os daemon start` (auto-restarts on `init` too); check `void-os daemon logs --tail 40` |

## 8. Known limitations (current state)

- `void-os ask` is one-shot; if an agent invokes `ask_user`, the call exits 6 and points you to `void-os chat`. Use chat for anything that needs back-and-forth.
- Daemon binds one vault at a time on port 7777; multi-vault requires multiple ports and isn't supported yet.
- `claudev` PATH dependency is documented above; a dedicated `VOID_OS_CC_BIN` env var may land later.
- Plugin chat list / agent panel UX is being iterated under the `vos-v1-router` milestone.

## 9. Next steps for new users

- Read `<vault>/CLAUDE.md` — the schema and conventions Tinker enforces.
- Ask Tinker: "list your tools" to see your seed agent's capabilities.
- Ask Tinker: "create eva, lean stub for journaling" to bootstrap your first specialist (Tinker drafts and asks you to confirm before writing).
- TODO(VOS-?): link the published router-surfaces spec and vault migration spec once they land at stable paths under `docs/`.

## 10. Where to file bugs

GitHub issues at github.com/makscee/void-os. Please include the output of `void-os daemon logs --tail 80` and the exact command that failed.

---

## Repo layout (for contributors)

- `bin/void-os` — CLI entrypoint dispatched to `cli/<command>.ts`.
- `cli/` — CLI commands (`init`, `daemon`, `ask`, `chat`, `agents`, `vault`, `plugin`).
- `daemon/` — Bun + Hono HTTP/WS daemon; spawns Claude Code via `claudev`.
- `plugin/` — Obsidian plugin (built into `plugin/dist`).
- `starter-vault/` — vault skeleton copied by `void-os init`.
- `protocol/` — shared TS types + client for daemon/CLI/plugin.
- `e2e/`, `plugin/e2e/`, `daemon/test/` — test suites.
- `scripts/fresh-vault.sh` — convenience wrapper around `init` for dev loops.

## License

See [LICENSE](LICENSE).
