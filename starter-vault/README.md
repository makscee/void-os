# starter-vault — seed content for `$VOID_OS_VAULT_ROOT`

This directory ships with `void-os` and contains the minimal set of files needed for the daemon to boot a usable vault:

- `CLAUDE.md` — shared context every spawned CC subprocess inherits.
- `agents/maya/`, `agents/journaler/`, `agents/task-tracker/` — three starter agents.

## One-time seed

Point `$VOID_OS_VAULT_ROOT` at the folder you want to use as a vault, then copy this directory's contents into it:

```sh
cp -rn starter-vault/. "$VOID_OS_VAULT_ROOT"/
```

`-n` (no-clobber) preserves any files you already have. **Do not** drop the `-n` — plain `cp -r` overwrites file-by-file and can silently destroy hand-tuned agents.

Equivalent: `rsync -a --ignore-existing starter-vault/ "$VOID_OS_VAULT_ROOT"/`.

After seeding, restart the daemon. The plugin's "new chat" picker will list `maya`, `journaler`, `task-tracker`.

## Customizing

Edit any agent's `agent.md` in-place inside your vault — changes take effect on the next message in any chat using that agent (no restart). See `vault/projects/void-os/CONTEXT.md` for the full schema.