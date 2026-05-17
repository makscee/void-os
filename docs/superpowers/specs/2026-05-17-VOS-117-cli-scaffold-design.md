# VOS-117 — CLI scaffold: daemon control + introspection

Status: design
Task: vault/work/tasks/active/VOS-117-cli-scaffold-daemon-and-introspection.md
Parent milestone: vos-cli-support
Depends on: VOS-116 (daemon HTTP API surface — shipped)
Next: VOS-118 (CLI agent communication — `ask`, `chat`)

## Purpose

Ship the `void-os` CLI binary with the foundational subcommands: daemon lifecycle, agent listing, vault debug ops, plugin install helper. No agent chat (that's VOS-118). This task lands the binary, the subcommand router, the shared protocol/ HTTP client, and the `bun link` install story so subsequent CLI tasks plug into a working chassis.

## Non-goals

- `void-os ask` and `void-os chat` (VOS-118).
- `void-os init` rework (VOS-119; existing scaffold stays as-is here).
- npm/brew distribution. `bun link` only.
- launchd auto-start. Plugin auto-spawn is VOS-120.
- Multi-vault daemon (single vault per running daemon stays the model).

## Architecture

### Component layout

```
workspace/void-os/
  bin/void-os                         # dispatcher; refactored to forward full argv to handler
  cli/
    lib/
      args.ts                         # shared flag/positional parser
      output.ts                       # print(value, {json, columns}) helper
      state-dir.ts                    # resolves ~/.void-os, paths for token/pid/port/log
      client.ts                       # builds protocol client from state-dir + env overrides
    daemon.ts                         # start | stop | status | logs subdispatch
    agents.ts                         # list
    vault.ts                          # read | write | list
    plugin.ts                         # install | status
    init.ts                           # untouched (VOS-119 owns this)
  protocol/src/
    client.ts                         # makeClient({base, token}) → typed methods
    agents.ts                         # AgentListEntry, AgentsListResp Zod schemas (new)
    index.ts                          # re-exports
  package.json                        # add  "bin": { "void-os": "./bin/void-os" }
```

Each `cli/<cmd>.ts` owns its own subcommand dispatch (`cli/daemon.ts` switches on `args[0]` ∈ {start, stop, status, logs}). One level of nesting only — no `cli/daemon/start.ts` split. Keeps the bin dispatcher trivial and matches the existing `cli/init.ts` pattern.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | runtime error (daemon up but operation failed; bad input data; etc.) |
| 2 | usage error (bad flags, missing required positional, unknown command) |
| 3 | daemon unreachable (network refused, /health timeout, missing port file) |

These are stable contract — scripts and the LXC E2E (VOS-121) depend on them.

### `bun link` story

Add to `workspace/void-os/package.json`:

```json
{
  "bin": { "void-os": "./bin/void-os" }
}
```

User runs `bun link` once in `workspace/void-os/`; the `void-os` binary appears on PATH (Bun symlinks into its global bin dir). The existing `bin/void-os` shebang `#!/usr/bin/env bun` keeps working unchanged.

Acceptance: from a fresh shell after `bun link`, `void-os --help` prints the top-level usage.

## protocol/ HTTP client

```ts
// protocol/src/client.ts
export interface ClientOpts {
  base: string;
  token: string;
  fetch?: typeof fetch;  // injectable for tests
}

export function makeClient(opts: ClientOpts): {
  health(): Promise<HealthResp>;
  agents: {
    list(): Promise<AgentsListResp>;
  };
  vault: {
    read(path: string): Promise<VaultFileResp>;
    write(path: string, content: string): Promise<VaultWriteResp>;
    list(glob?: string, opts?: { depth?: number }): Promise<VaultListResp>;
  };
  chat: {
    stream(chatId: string): AsyncIterable<ChatStreamEvent>;  // SSE; for VOS-118
  };
}
```

Behavior:

- Single fetch wrapper sets `Authorization: Bearer <token>` and JSON `Content-Type` for writes.
- Response shape Zod-parsed against `protocol/src/*` schemas. Drift between daemon and client surfaces as a parse error at the seam.
- Error mapping:
  - HTTP 4xx → `ApiError(code, message, status)` (typed; thrown).
  - HTTP 5xx → `ServerError(status, body)` (thrown).
  - Network refused / DNS / fetch reject → `UnreachableError(cause)`. CLI catches and exits with 3.
- `chat.stream` parses SSE frames into `ChatStreamEvent` (existing schema in `protocol/src/chat-stream.ts`). Method ships in this task; no CLI command consumes it until VOS-118.

Daemon-side gap to fill in this task:

- Add `protocol/src/agents.ts` with `AgentListEntry = { name, description }` and `AgentsListResp = { agents: AgentListEntry[] }`. Daemon route at `daemon/src/api/agents.ts` already returns this shape — only the schema is missing. Daemon route is left untouched.
- Re-export from `protocol/src/index.ts`.

## State directory (`~/.void-os/`)

Already houses `token` (shipped by VOS-116 `auth/token.ts`). This task adds siblings:

| File | Written by | Purpose |
|------|------------|---------|
| `token` | daemon `ensureToken()` | bearer auth |
| `daemon.pid` | `daemon start` | PID for liveness + stop |
| `daemon.port` | `daemon start` | port for subsequent CLI calls |
| `daemon.log` | `daemon start` (redirect stdout+stderr) | tailable log |

CLI resolves base URL: `VOID_OS_BASE` env > `http://127.0.0.1:<port-file>` > default `http://127.0.0.1:7777`. Resolves token: `VOID_OS_TOKEN` env > `~/.void-os/token`. If neither exists → exit 3 with hint "run `void-os daemon start`".

## Daemon lifecycle

### `daemon start [--port N] [--vault PATH]`

1. If `daemon.pid` exists and process is alive → exit 0, print `already running (pid=N port=N)`.
2. Resolve port: `--port` flag > `VOID_OS_PORT` env > 7777.
3. Resolve vault: `--vault` > `VOID_OS_VAULT_ROOT` env > daemon's own default (`~/Library/Application Support/void-os/vault`). `mkdirSync(vaultRoot, {recursive: true})` before spawn — daemon's `index.ts` exits with code 2 if dir is missing, and we'd rather not make the user wait the full poll timeout for an instant failure.
4. Open `~/.void-os/daemon.log` (append mode), grab fd.
5. `spawn("bun", ["run", "<prefix>/daemon/src/index.ts"], { detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, VOID_OS_PORT, VOID_OS_VAULT_ROOT } })`. `child.unref()`.
6. Write `child.pid` → `daemon.pid`. Write port → `daemon.port`.
7. Race `child.once('exit', ...)` against polling `GET /health` every 200 ms for up to 10 s.
   - 200 OK: print `void-os daemon ready (pid=N port=N vault=<root> version=<v>)`. Exit 0.
   - Child exits early (any non-zero code, typically port-in-use / DB locked / boot probe fail): immediately abort the poll, remove pid + port files, print last 20 lines of `daemon.log` to stderr, exit 1. No reason to make the user wait the full 10 s for a failure visible in 50 ms.
   - Timeout: kill child, remove pid + port files, print last 20 lines of `daemon.log` to stderr, exit 1.
8. If spawn itself fails (e.g. `bun` missing) → exit 1 with the OS error.

### `daemon stop`

1. Read `daemon.pid`. Missing or unparseable → exit 0, print `not running` (idempotent).
2. Check process alive (`kill(pid, 0)`). Dead → remove stale files, print `not running`, exit 0.
3. Confirm the live PID actually belongs to void-os before signaling: read `daemon.port`, hit `GET /health` with the on-disk token. Only proceed to step 4 if /health returns 200 with a `version` field. Otherwise treat as stale (recycled PID belonging to an unrelated app) — remove pid + port files, print `not running (stale pid file)`, exit 0. Never SIGTERM a PID we can't positively identify as the daemon.
4. `kill(pid, SIGTERM)`. Poll up to 5 s for exit. Still alive → `kill(pid, SIGKILL)`, wait up to 2 s.
5. Remove `daemon.pid` and `daemon.port`. Print `stopped`. Exit 0.

### `daemon status [--json]`

| State | Detection | Human output | JSON | Exit |
|-------|-----------|--------------|------|------|
| stopped | no pid file OR pid dead | `stopped` | `{running:false}` | 0 |
| running healthy | pid alive AND `/health` 200 | 6 lines: pid, port, vault_root, uptime_s, version, sessions | `{running:true, pid, port, ...health}` | 0 |
| running unhealthy | pid alive AND `/health` error/timeout | `running (pid=N) but unhealthy: <err>` | `{running:true, pid, port, error}` | 1 |

### `daemon logs [-f | --follow] [--tail N]`

- Default: print last 200 lines of `daemon.log` to stdout, exit 0.
- `--tail N`: last N lines instead of 200.
- `-f` / `--follow`: spawn `tail -f <path>` with `stdio: "inherit"`. Ctrl-C → SIGINT propagates; CLI exits with child's exit code.
- Missing log file → `no daemon log yet` on stderr, exit 0 (not an error — daemon may have never started).

## Other subcommands

### `agents list [--json]`

- `client.agents.list()`.
- Human: two-column `name  description`, max line 80 cols (truncate description with `…`).
- JSON: response envelope verbatim.
- Daemon down → exit 3 with `daemon not running; try \`void-os daemon start\``.

### `vault read <path> [--json]`

- `client.vault.read(path)`.
- Human: write `resp.content` (UTF-8 string from `/vault/file` envelope) raw to stdout. **`cat`-semantics**: no added trailing newline — if the file ends in `\n`, output ends in `\n`; if not, it doesn't. This contract is byte-exact and must be covered by a test asserting `process.stdout.write` receives `resp.content` and nothing else.
- Binary-flagged responses (4xx `E_BINARY` from daemon) → exit 1 with `binary file, use --json`.
- JSON: full envelope verbatim.

### `vault write <path> {--content STR | --from-file LOCAL | --stdin}`

- Exactly one source flag required. Zero or two+ → exit 2 with usage error.
- `--stdin`: read all of stdin to UTF-8 string.
- `--from-file LOCAL`: read local file.
- `client.vault.write(path, content)`.
- Human: `wrote <path> (<n> bytes)`. JSON: envelope.

### `vault list [<glob>] [--depth N] [--json]`

- Default depth 1 (matches daemon default after VOS-116 review fix).
- `<glob>` positional optional.
- Human: one path per line.
- JSON: `{ entries: [...] }`.

### `plugin install [--vault PATH] [--force]`

1. Resolve target vault: `--vault` > `client.health().vault_root` > error `no --vault and daemon not running; exit 3`.
2. Source: `<prefix>/plugin/dist`. Missing → exit 1 with `plugin not built; run \`bun run build\` in plugin/`.
3. Target: `<vault>/.obsidian/plugins/void-os/`.
4. Idempotency: if target exists and its `manifest.json` version matches source's version AND `--force` not set → exit 0 with `up-to-date (version X)`. No file ops.
5. Otherwise `cpSync(src, target, {recursive: true, force: true})`. Print `installed plugin to <target> (version X)`. Exit 0.

### `plugin status [--vault PATH] [--json]`

1. Resolve target vault as above.
2. Read `<target>/manifest.json` if present, read source `plugin/dist/manifest.json`.
3. Status enum: `missing` (no target), `up-to-date` (versions match), `upgrade-available` (target older), `ahead` (target newer than source — unusual, just report).
4. Human: `installed: vX  source: vY  status: <enum>`. JSON: `{installed, source, target_path, status}`.

### `--help` / `-h`

- Every command and subcommand has a per-handler `USAGE` constant printed verbatim. Exits 0.
- Top-level `--help` lists all commands with one-line summaries.
- Unknown command or subcommand → print top-level (or scoped) usage to stderr, exit 2.

## File-by-file change list

| File | Action |
|------|--------|
| `workspace/void-os/package.json` | add `"bin": { "void-os": "./bin/void-os" }` |
| `workspace/void-os/bin/void-os` | rewrite top-level dispatcher; pass full `args` (not `args.slice(1)`) so handlers see their own subcommand |
| `workspace/void-os/cli/lib/args.ts` | new — flag + positional parser; supports `--key val`, `--key=val`, `-k`, bool, repeated |
| `workspace/void-os/cli/lib/output.ts` | new — `printHuman(rows, cols)`, `printJson(value)`, `column-truncate` |
| `workspace/void-os/cli/lib/state-dir.ts` | new — `stateDir()`, `tokenPath()`, `pidPath()`, `portPath()`, `logPath()` |
| `workspace/void-os/cli/lib/client.ts` | new — `buildClient()` reads state-dir + env, returns `protocol/client` instance; throws `UnreachableError`-typed errors |
| `workspace/void-os/cli/daemon.ts` | rewrite — start/stop/status/logs subdispatch |
| `workspace/void-os/cli/agents.ts` | new |
| `workspace/void-os/cli/vault.ts` | new |
| `workspace/void-os/cli/plugin.ts` | new |
| `workspace/void-os/protocol/src/client.ts` | new |
| `workspace/void-os/protocol/src/agents.ts` | new — `AgentListEntry`, `AgentsListResp` |
| `workspace/void-os/protocol/src/index.ts` | re-export `client` + `agents` |
| `workspace/void-os/docs/api.md` | add `~/.void-os/` paths + CLI exit codes table |

No daemon source touched. No plugin source touched. `cli/init.ts` and `cli/init.test.ts` untouched.

## Testing strategy

### Unit (per file under test, run by `bun test`)

- `cli/lib/args.ts` — parser fuzz: flag forms, missing values, repeated flags, unknown flags.
- `cli/lib/output.ts` — column truncation, JSON envelope shape.
- `cli/lib/state-dir.ts` — HOME swap (use `process.env.HOME ?? os.homedir()` per VOS-116 T3 lesson; Bun `os.homedir()` caches at startup).
- `protocol/src/client.ts` — inject mock `fetch`, assert: bearer header set, JSON Content-Type for writes, Zod parse on success, `ApiError`/`UnreachableError` thrown on failures.
- `protocol/src/agents.ts` — schema accepts daemon's payload shape, rejects malformed.

### Integration (per subcommand)

- Daemon lifecycle (`daemon start/status/stop`): real daemon in tmp HOME, real port (find free port), real `bun link`-less invocation via `./bin/void-os` with `VOID_OS_PREFIX` set. Sequence: start → assert /health 200 → status (JSON) → stop → assert pid file gone. Restart idempotency: second start returns `already running`. Stop idempotency: second stop returns `not running` exit 0.
- `daemon start` failure path: spawn against an in-use port (start two), assert second start times out, log captured, pid file cleaned up, exit 1.
- `daemon logs --tail 5`: write known content to log file, assert last 5 lines printed.
- `agents list`: against running daemon with seeded `agents/` dir; assert human format and `--json` shape.
- `vault read/write/list`: against running daemon in tmp vault; round-trip a file. Include a **byte-exact stdout test** for `vault read`: write a file with content `"hello\n"`, assert CLI stdout is exactly `"hello\n"` (6 bytes, one newline). Also test a file without trailing newline (`"hi"`, 2 bytes, no newline).
- `plugin install`: tmp vault, tmp `plugin/dist/manifest.json`; assert target exists, version line printed. Re-run without `--force` → `up-to-date`. Re-run with `--force` → overwrite.
- `plugin install` without daemon and without `--vault` → exit 3, error message present.

### T0 — `bun link` spike (5 min, before any code)

Before touching anything else, verify the install story:

1. In `workspace/void-os/`, run `bun link`.
2. From a fresh shell: `which void-os` (expect a path in bun's global bin), then `void-os --help` (expect non-zero exit since command doesn't exist yet, but the shebang and dispatcher must run).
3. If `bun link` refuses the private workspace root or `which` returns nothing: fall back to either (a) per-workspace `bin` in `daemon/package.json`, or (b) document a manual `install` script that symlinks `bin/void-os` into `/usr/local/bin/`. Update spec before continuing.
4. Tear down with `bun unlink` so subsequent tasks start clean.

Record the outcome in the task Work Log. Every downstream CLI task (VOS-118, VOS-120, VOS-121) inherits whatever install path lands here, so a 5-minute spike here saves a multi-task rework later.

### Smoke (manual, before /done)

`bun link` in `workspace/void-os/`, then in a fresh shell:

```
void-os --help
void-os daemon start
void-os daemon status
void-os agents list
void-os vault list
void-os plugin status
void-os daemon stop
```

Each must exit 0 (or 3 for `agents list` if no agents seeded — acceptable). Log the SHA + raw transcript in the task Work Log.

## Risks

1. **Bun `bun link` symlink semantics differ from npm.** If the symlink resolves through bun's global dir and bun isn't on PATH at invocation, the `#!/usr/bin/env bun` shebang fails. Mitigation: README documents `bun link` then `which void-os` smoke check.
2. **Detached spawn inherits parent env.** Sensitive env (e.g. `VOID_OS_DB`) bleeds into the daemon. Mitigation: only set documented `VOID_OS_*` keys; pass `env: { ...process.env, ... }` consciously, document the inheritance in `docs/api.md`.
3. **Port collision when start runs concurrently.** Mitigation: PID-file check is the first action; second concurrent `start` either sees existing pid (no-op) or races and fails the /health poll (cleanup path triggers). Document as known limitation; full fix is a daemon-side lockfile, out of scope.
4. **`tail -f` not portable to non-Unix.** Mitigation: macOS + Linux only for v1, matches CLAUDE.md project scope. Windows is out of scope.
5. **Plugin `dist/` missing in fresh clones.** Mitigation: `plugin install` already errors clearly; LXC E2E (VOS-121) will document `bun run build` as a prereq.

## Decisions log

- HTTP client lives in `protocol/` package (single source of truth; plugin can adopt in VOS-120).
- State files under `~/.void-os/` (co-located with token; single dir to nuke for reset).
- `plugin install` defaults to daemon's `vault_root`, overridable via `--vault`.
- `daemon start` blocks until `/health` 200 (default behavior, no flag); 10 s timeout.
- Human-friendly output default; `--json` flag for scripts.
- Hand-rolled argv parser (no `commander`/`yargs` dep) — surface is small enough.
- Top-level `bin` registration via root `package.json` (not per-workspace) — `bun link` installs from the workspace root.
