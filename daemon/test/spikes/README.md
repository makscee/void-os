# daemon/test/spikes

One-off verification scripts kept in-repo so we can re-run them on
upstream-binary upgrades. Not part of `bun test`.

## vos-106-hook-fail-mode.ts

Verifies CC's PreToolUse hook fails-closed when the hook script errors.
Re-run whenever `daemon/package.json` `voidos.claudeCodeVersion` is bumped:

    bun run daemon/test/spikes/vos-106-hook-fail-mode.ts

Exit 0 = fail-closed (design holds). Exit 1 = fail-open (design must change).
