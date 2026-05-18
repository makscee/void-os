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
- A Claude Code wrapper — void-os spawns CC subprocesses via a wrapper binary (default name: `claudev`). Point the daemon at it via either:
  - `VOID_OS_CC_BIN=/abs/path/to/claudev` in the daemon's env (preferred — works regardless of PATH; e.g. `export VOID_OS_CC_BIN=$HOME/.claudev/bin/claudev`), or
  - `claudev` on PATH for whatever shell starts the daemon (`which claudev` confirms).

  The daemon pre-flights this at boot and refuses to start with an actionable error if neither resolves.
- Anthropic API access — `claudev` handles auth for spawned CC sessions.
- Optional: `gh` CLI authed, if you want `void-os init` to create a private GitHub repo for your vault.

### Linux / LXC
- Ubuntu 22.04+ or Debian 12+
- `apt install -y curl git build-essential`
- bun via the same `curl -fsSL https://bun.sh/install | bash`
- A Claude Code wrapper reachable via `VOID_OS_CC_BIN` or on PATH (same as Mac)

## 3. Mac install (the verified path)

```bash
git clone https://github.com/<your-fork>/void-os
cd void-os
bun install
bun link                # `void-os` now on PATH
void-os init            # interactive picker
```

`void-os init` walks you through:

1. **Preflight** — confirms `bun` and `claudev` are resolvable. Set `VOID_OS_CC_BIN=/abs/path/to/claudev` if claudev isn't on PATH.
2. **Pick a vault location** — current folder, `~/void-os-vault`, `~/vault`, or a custom path. The picker refuses paths inside the void-os clone itself.
3. **Seed** — `git init` in the vault, starter-vault tree, `.claude/skills` symlink, initial commit. Idempotent.
4. **Build + install plugin** — `bun install` + `bun run build` inside the repo's `plugin/`, then **copy** the built artifacts into `<vault>/.obsidian/plugins/void-os/`. Always rebuilds on each init — pass `--skip-build` if you've just built.
5. **Open in Obsidian?** (y/N) — answer `y` to launch Obsidian against the new vault.

The plugin auto-spawns the daemon on Obsidian load. **`void-os init` does NOT start the daemon itself.** If you prefer CLI:

```bash
void-os daemon start --vault <path>
void-os ask tinker "hi"
```

`daemon start` is single-instance: if Obsidian already spawned a daemon for that vault, you get `already running (pid=… port=… vault=…)` and exit 0. Stale pidfiles (daemon crashed) are cleaned up automatically.

To create a GitHub repo and push the initial commit, pass `--gh-repo <name>` explicitly. Default is no push.

## 4. Linux / LXC install (non-interactive)

```bash
git clone https://github.com/<your-fork>/void-os
cd void-os
bun install
bun link

# claudev must be resolvable. Either on PATH or via env:
export VOID_OS_CC_BIN=/usr/local/bin/claudev

void-os init --non-interactive --vault /srv/void-os-vault
```

`--non-interactive` requires `--vault <path>`. No picker, no Obsidian prompt — init prints the `obsidian://open?path=…` URL at the end if you want to open it from a desktop.

Flags:
- `--vault <path>` — vault location (required in non-interactive mode)
- `--skip-build` — skip `bun install` + plugin build (dev iteration)
- `--force` — overwrite a non-empty target dir
- `--gh-repo <name>` — opt in to creating a private GitHub repo + pushing initial commit
- `--gh-public` — make the gh repo public (requires `--gh-repo`)

Then start the daemon explicitly:

```bash
void-os daemon start --vault /srv/void-os-vault
void-os ask tinker "hi"
```

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
| daemon refuses to start with `CC wrapper not found ... Set VOID_OS_CC_BIN ...` | CC wrapper neither at `$VOID_OS_CC_BIN` nor on PATH for the daemon process | export `VOID_OS_CC_BIN=/abs/path/to/claudev` (e.g. `$HOME/.claudev/bin/claudev`) in the shell that starts the daemon, **then** `void-os daemon stop && void-os daemon start`. Or add the wrapper's directory to PATH and restart. |
| `void-os ask` errors `Executable not found in $PATH: "claudev"` (legacy daemon without VOS-134 pre-flight) | CC wrapper not resolvable when the daemon spawned CC | upgrade to a daemon build that pre-flights (VOS-134+); set `VOID_OS_CC_BIN` and restart |
| daemon errors with `EADDRINUSE: port 7777` | another vault's daemon is already running | `void-os daemon stop` first, then start for your target vault |
| `init` says "plugin build artifact missing" | fresh clone without `bun install` | re-run `bun install`, then `void-os init` |
| Obsidian doesn't show void-os under Community plugins | plugin install step didn't seed | check `<vault>/.obsidian/plugins/void-os/manifest.json` exists; if not, from the repo root run `( cd plugin && VOID_OS_PLUGIN_OUT="$PWD/dist" bun run build )` then re-run `void-os init` |
| `void-os ask` exits 7 with `error: ...` | Run errored — the message tells you what; common: model called a tool the agent doesn't have | follow the error; for interactive flows, switch to `void-os chat` |
| `void-os ask` exits 6 saying "agent asked for input; this requires interactive mode" | agent invoked `ask_user` mid-run, which `ask` can't satisfy | re-run with `void-os chat <agent>` |
| `void-os ask` exits 4 saying "agent '<name>' not found" | agent not registered in vault | `void-os agents list` to see what's there; ask Tinker to draft the missing agent |
| `void-os ask` exits 5 saying "vault not configured" | `VOID_OS_VAULT_ROOT` unset and `~/Library/Application Support/void-os/vault` missing | run `void-os init`, or `export VOID_OS_VAULT_ROOT=<path>` before `daemon start` |
| `void-os ask` exits 3 saying "daemon not running" | daemon down or unreachable | `void-os daemon start --vault <path>` (or open Obsidian, which spawns the daemon); check `void-os daemon logs --tail 40` |

## 8. Known limitations (current state)

- `void-os ask` is one-shot; if an agent invokes `ask_user`, the call exits 6 and points you to `void-os chat`. Use chat for anything that needs back-and-forth.
- Daemon binds one vault at a time on port 7777; multi-vault requires multiple ports and isn't supported yet.
- The CC wrapper is resolved via `VOID_OS_CC_BIN` (preferred) or PATH lookup of `claudev`; the daemon pre-flights at boot and surfaces the fix in the error message.
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
