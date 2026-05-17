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
