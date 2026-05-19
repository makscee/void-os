# scripts/

Helper scripts for void-os development and manual UX gates. Not part of the shipped CLI.

## fresh-vault.sh

Wipe + rebuild a void-os vault for repeatable manual UX passes (VOS-115 and successors). One command: build plugin → wipe target dir → `void-os init` → symlink plugin into Obsidian's plugins dir → start daemon.

```
scripts/fresh-vault.sh [<path>] [--yes] [--skip-plugin] [--force-stop]
```

- `<path>` — target vault dir (default `$HOME/vault-test`).
- `--yes` — skip the typed-`yes` wipe confirmation.
- `--skip-plugin` — skip plugin pre-build and symlink. Use this in LXC E2E where Obsidian isn't installed.
- `--force-stop` — stop the daemon even if it's serving a vault other than `<path>` (kills real-`~/vault` work sessions; prints a warning).

### Guards

- Refuses anything not strictly inside `$HOME`, the literal `$HOME` itself, and the literal `$HOME/vault` (the real vault).
- Refuses to stop a running daemon if it's serving a different vault, unless `--force-stop`.
- Plugin pre-build runs **before** the wipe — a build failure leaves the vault untouched.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success (incl. user-aborted, see note below) |
| 2 | guard rejected the path, or daemon serves a foreign vault without `--force-stop` |
| non-zero from `void-os init` / `daemon start` | propagated; script halts |

> Note: user-aborted-at-confirmation also exits 0. CI scripts wanting to distinguish "wiped & re-inited" from "user said no" should pass `--yes`.

### LXC E2E

For headless / containerized smoke runs:

```
scripts/fresh-vault.sh /root/vault-test --yes --skip-plugin
```

## Manual smoke testing — per-task isolation

`smoke-up.sh <ID>` stands up an isolated void-os stack (vault + daemon + Obsidian) at `/tmp/void-os-smoke/<ID>/` for the worktree at `/Users/admin/hub-wt/<ID>/`. Operator's main daemon (port 7777, `~/void`) and main Obsidian are not touched.

Isolation mechanism: `HOME` is overridden to the smoke root so the daemon's pidfile lands in `<smoke>/home/.void-os/daemon.json` instead of `~/.void-os/daemon.json`. Obsidian is launched with `--user-data-dir=<smoke>/obsidian-user-data` so it coexists with the main instance.

### Commands

| Cmd | Effect |
|---|---|
| `smoke-up.sh VOS-146` | Seed vault + spawn daemon + spawn Obsidian |
| `smoke-up.sh VOS-146 --no-obsidian` | Daemon only |
| `smoke-up.sh VOS-146 --reset` | Wipe `/tmp/void-os-smoke/VOS-146/` and re-seed |
| `smoke-down.sh VOS-146` | Kill daemon + Obsidian; preserve vault |
| `smoke-down.sh VOS-146 --purge` | Kill + remove smoke root entirely |
| `smoke-dogfood.sh VOS-A VOS-B` | E2E acceptance against two IDs |

### Ports

`7800 + cksum(ID) % 100`. Probe + bump on collision. Port is sticky across `up` runs (recorded in `/tmp/void-os-smoke/<ID>/daemon.port`).

### Plugin layout — per-file symlinks (not a dir symlink)

`<vault>/.obsidian/plugins/void-os/` is a **real directory**. Every entry in the worktree's `plugin/dist/` is symlinked individually (`main.js`, `manifest.json`, `styles.css`, and any future artefact the build emits — the loop globs `$PLUGIN_DIST/*`). `data.json` is the only exception: it is excluded from the symlink loop and lives as a real local file inside the plugin dir, so smoke writes (daemonUrl, settings tab edits) do not leak back into the worktree's `plugin/dist/`. Legacy directory-symlinks created by older smoke-up runs are detected and replaced on the next run.

### daemonUrl wiring

smoke-up writes `<vault>/.obsidian/plugins/void-os/data.json` with `daemonUrl` set to the per-ID daemon URL (`http://127.0.0.1:<port>`). The plugin's `urlsFromAttachment` resolution ranks `settings.daemonUrl` ahead of attachment-derived URLs, so the plugin targets the smoke daemon — not the operator's main daemon — even though both run on the same loopback.

### Plugin enable on a fresh vault

smoke-up writes the plugin id into `<vault>/.obsidian/community-plugins.json` so Obsidian auto-enables it on first launch. If the vault was scaffolded by an older version of smoke-up (or by `void-os init` directly) and the plugin isn't loading, do a **one-time** manual enable in Obsidian: Settings → Community plugins → Enable void-os. The enabled state then persists in `community-plugins.json` and is reused on subsequent `smoke-up` runs for the same ID.

### Repeat `up` behavior

Reuses existing vault and daemon (if alive). Always rebuilds the plugin so the per-file-symlinked dist tracks the worktree's HEAD. The `data.json` daemonUrl is re-seeded each run (cheap, idempotent). Pass `--reset` for a clean wipe.

### Pre-built smoke states

`scripts/scenarios/` holds scripts that drive smoke Obsidian into specific UI states (chat panel open on a seeded conversation, etc.) via raw-WebSocket CDP. See `scripts/scenarios/README.md` for the catalogue and the recipe each script follows. Operator's main Obsidian is never touched.

### Known limitations

- **Port-collision rollover is racy.** The port for `<ID>` is `7800 + cksum(<ID>) % 100`, with a probe-and-bump fallback when the base port is already bound. The probe (`lsof`) and the daemon's actual `bind()` happen in separate processes, so two concurrent `smoke-up` invocations whose base ports collide may both pick the same free port and one of them will fail to bind. If you see a bind failure on a concurrent run, just rerun `smoke-up.sh <ID>` — the sticky `daemon.port` file written by the winning run will cause the second invocation to pick the next free port via the same probe.
