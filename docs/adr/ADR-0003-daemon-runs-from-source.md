# ADR-0003: Daemon runs from source tree (VOS-106)

## Status
Accepted — 2026-05-16.

## Context
VOS-106's PreToolUse hook script (`daemon/src/providers/claude-code/hook-bin/pre-tool-use.ts`) is invoked by spawned CC processes via `bun <abs-path>`. The script uses relative imports (`../../../permissions/match`, `./parse-shell-paths`) that only resolve when the file is on disk at its source-tree location.

If the daemon is ever packaged (e.g. `bun build --compile` to a single binary, or shipped via `bun install` from a published artifact), `import.meta.dir` resolves into the bundle and the hook spawn-path no longer points at a readable file.

## Decision
Until a packaging ticket lands, the daemon **must run from source**. `buildApp` asserts `existsSync(hookScriptPath)` at boot; absence raises a fatal error referencing this ADR.

## Consequences
- Dev / dogfood / single-host prod: no change.
- Future packaging: ships a compiled hook artifact (`bun build --compile daemon/src/providers/claude-code/hook-bin/pre-tool-use.ts --outfile <out>`) and updates `hookScriptPath` to point at the artifact. Out of scope for VOS-106.
