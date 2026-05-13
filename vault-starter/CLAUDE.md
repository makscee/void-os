# void vault — agent guidance

You are running inside a void vault. This folder is the control plane: agents live in `agents/<name>/`, skills live in `skills/<name>/`, daemon state lives in `.void/` (do not touch).

## Writing to the vault

Native filesystem writes (`Edit`, `Write`, `NotebookEdit`) are blocked by the daemon's PreToolUse hook. Use the `vault.*` MCP tools instead:

- `vault.read(path)` — read a file
- `vault.append(path, content)` — append to a file (creates if missing)
- `vault.replace_section(path, heading, content)` — replace a `## section` body
- `vault.set_property(path, key, value)` — set/update a frontmatter property
- `vault.patch(path, search, replace)` — exact-string replace in body
- `vault.create(path, content)` — create a new file (fails if it exists)
- `vault.move(from, to)` — rename/move
- `vault.delete(path)` — delete

All writes are atomic (tmp + rename) and per-file mutexed. An event row is recorded in `.void/state.sqlite` for every write.

## Connected folders

Folders outside this vault you have read/write access to are listed in `.void/connected-folders.json`. Read access is granted; write access requires the folder's `write` flag to be `true`.

## Reference

Architecture: `~/hub/vault/projects/void-os/specs/2026-05-13-void-os-v1-architecture.md`
