# VOS-106 — Loader Integration: Agent Scopes + MCP Allowlist

**Status:** Design
**Date:** 2026-05-16
**Owner:** VOS-106
**Depends on:** VOS-85 (PermissionEngine), VOS-89 (ask_agent + agent_cards), VOS-92 (agent registry), VOS-97 (MCP tool registry)
**Blocks:** VOS-105 (14-day dogfood)

## 1. Problem

VOS-103 round-2 probes proved that prompt-level routing is dominated by tool availability: spawned CC subprocesses retain full default tool access, so agents reach for `Read`/`Glob`/`Bash` instead of `ask_agent(...)`. Three concrete gaps were identified during VOS-103 closure and verified during VOS-106 exploration:

1. **No MCP wiring.** `createCcSpawner` invokes `claudev claude -p prompt --output-format stream-json --verbose` with no `--mcp-config` and no `--settings`. CC has zero MCP servers configured. The `/mcp` endpoint exists, but no spawned CC has ever connected to it. `ask_agent` / `vault.read` / `ask_user` are unreachable from real CC runs (the `fake` provider hits `/mcp` directly via loopback, so VOS-89/97/100 tests passed despite the gap).
2. **No PreToolUse gating.** The `PermissionEngine` (`daemon/src/permissions/engine.ts`) ships from VOS-85 but has zero callers in the spawn path. Writes outside `vault/agents/**` etc. would succeed regardless of `write_scope`.
3. **No per-agent tool constraint.** Even once MCP is wired, every agent would see the same tool set. The CONTEXT.md "default-injected by daemon" claim for `ask_agent` is aspirational — no per-spawn allowlist exists.

The starter-vault hardened personas (VOS-103) already say the right thing in prose. They cannot work until the runtime enforces those scopes.

## 2. Acceptance (mirrors task file, with one expansion)

- [ ] Daemon resolves each agent's scopes at spawn time and stores the resolved `{readPaths, writePaths}` on the `runs` row (new column `scopes_json TEXT`).
- [ ] CC subprocess `cwd = $VOID_OS_VAULT_ROOT`; the per-run CC settings file lists `additionalDirectories = readPaths-outside-vault` (paths under `~/` or absolute), and the in-vault subtree restriction is handled by PreToolUse alone (per Q2 decision).
- [ ] PreToolUse hook denies `Edit` / `Write` / `MultiEdit` (any tool with a `file_path` / `path` argument) whose target falls outside `writePaths` or matches `SYSTEM_DENY_FOR_WRITE`. Refusal returns `{continue: false, stopReason: "<engine reason>"}`.
- [ ] PreToolUse hook denies `Read` / `Glob` / `Grep` whose path falls outside `readPaths` (Q2: unified PreToolUse gate, no `--add-dir` subtree exclude).
- [ ] PreToolUse hook denies `Bash` whose argv contains a path arg landing outside `readPaths` (read-like Bash: `cat`, `head`, `tail`, `less`, `ls`, `grep`, `rg`, `find`, `git show`, `git log -- <path>`) or `writePaths` (write-like Bash: redirect `>`, `>>`, `tee`, `mv`, `cp`, `rm`, `sed -i`, `git mv`, `git add`, `git commit`, `git rm`). Bash gating is conservative — unknown shapes deny.
- [ ] **Scope expansion (Q1):** `--mcp-config <path>` written per-spawn pointing CC at `http://127.0.0.1:<port>/mcp?agent=<name>&run=<runId>`. CC connects and lists tools. `ask_agent` is always present in the listing. `vault.read` is always present.
- [ ] **vault.read gate (Q5):** `vault.read` MCP handler resolves the calling-agent identity from the URL query (`agent=<name>`) and gates `path` via `engine.canRead(absPath, agent)`. Denial returns `SCOPE_DENIED` error code.
- [ ] Empirical probe re-run (six probes from VOS-103, harness promoted into `daemon/test/probes/loader-integration.ts`, auto-picks first backlog `VOS-*` ticket for tt-promote, regex flexes around the picked ID):
  - maya / journal-Q → contains `ask_agent("journaler"`
  - maya / next-work-Q → contains `ask_agent("task-tracker"`
  - journaler / mark-done (against a completed VOS-* picked dynamically) → declines + names task-tracker
  - journaler / log-session → writes inside `vault/journal/**` only
  - task-tracker / journal-Q → declines + names journaler
  - task-tracker / promote → surfaces `/work --queue <picked-backlog-ID>` without executing `git mv`
- [ ] **≥5/6 strict pass.** The single allowed FAIL is for probe-design issues only.
- [ ] Code review gate.

## 3. Architecture

### 3.1 New components

| File | Purpose |
|---|---|
| `daemon/src/providers/claude-code/spawn-settings.ts` | Pure function `buildSpawnSettings({ agent, scopes, vaultRoot, daemonBase, runId, settingsDir }) → { settingsPath, mcpConfigPath, env }`. Writes two JSON files under `<settingsDir>/<runId>.{settings,mcp}.json` and returns paths + hook env. |
| `daemon/src/providers/claude-code/hook-bin/pre-tool-use.ts` | Standalone Bun script. Entry: reads stdin (CC PreToolUse payload), reads env (`VOS_READ_PATHS`, `VOS_WRITE_PATHS`, `VOS_SYSTEM_DENY`, `VOS_VAULT_ROOT`), classifies the tool, extracts path arg(s), picomatches, prints `{continue: bool, stopReason?: string}` to stdout. Exit 0 always. |
| `daemon/test/probes/loader-integration.ts` | Promoted from `/tmp/vos-103-reprobe.ts`. Auto-picks first backlog ticket via `readdirSync('<vault>/work/tasks/backlog')`. Runs six probes against a live daemon on `127.0.0.1:<port>` with `VOS_PROVIDER=claude-code`. Prints `PASS`/`FAIL`/`PROBE_DESIGN_BUG` table. Exit 1 if strict-pass < 5. |

### 3.2 Modified components

| File | Change |
|---|---|
| `daemon/src/providers/claude-code/index.ts` | `CcSpawnRequest` gains optional `engine: PermissionEngine` and `daemonBase: string`. Inside `spawn`: resolve scopes → call `buildSpawnSettings(...)` → extend argv with `--settings <p>` `--mcp-config <p>` → extend env with hook vars. Insert resolved `scopes_json` into `runs`. |
| `daemon/src/providers/factory.ts` | `ProviderDeps` gains `engine: PermissionEngine` and `daemonBase: string`. Threaded into `makeClaudeCodeProviderComposed`. |
| `daemon/src/providers/claude-code/spawner.ts` | `SpawnerIterDeps` adds `engine`, `daemonBase`. Passed through to `cc.spawn`. |
| `daemon/src/adapters/mcp/index.ts` | `mountMcp` route parses `c.req.query("agent")` → builds `loadAgentDefn(agentName)` once → passes the resolved `AgentDefn` and `engine` into `vault.read` factory per request. `ask_agent` already enforces `ask_agent_allow` via VOS-89. |
| `daemon/src/adapters/mcp/tools/vault-read.ts` | `VaultReadDeps` adds `engine: PermissionEngine` and `agent: AgentDefn`. Pre-read: `if (!engine.canRead(abs, agent)) return errResult("SCOPE_DENIED", reason)`. |
| `daemon/src/app.ts` | Construct `engine = createPermissionEngine({ vaultRoot, homeRoot: $HOME })` once. Pass into `mountMcp` and `makeProvider`. Threads `daemonBase = http://127.0.0.1:<port>` (already known at boot for fake-provider loopback). |
| `daemon/src/adapters/sqlite/migrations/0010_runs_scopes.sql` | `ALTER TABLE runs ADD COLUMN scopes_json TEXT;` (nullable; pre-VOS-106 runs leave NULL). |

### 3.3 Per-spawn settings file shape

`<tracesDir>/<runId>.settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Glob|Grep|Bash|Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "bun /abs/path/to/pre-tool-use.ts" }]
      }
    ]
  },
  "additionalDirectories": ["/abs/path/outside/vault/1", "..."]
}
```

`<tracesDir>/<runId>.mcp.json`:

```json
{
  "mcpServers": {
    "void-os": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp?agent=<agentName>&run=<runId>"
    }
  }
}
```

Argv extension to `Bun.spawn`:

```
[binary, "-p", prompt, "--output-format", "stream-json", "--verbose",
 "--settings", settingsPath,
 "--mcp-config", mcpConfigPath,
 ...(resumeFrom ? ["--resume", resumeFrom] : [])]
```

Env extension:

```
VOS_READ_PATHS    = JSON.stringify(readPaths)
VOS_WRITE_PATHS   = JSON.stringify(writePaths)
VOS_SYSTEM_DENY   = JSON.stringify(SYSTEM_DENY_FOR_WRITE_resolved)
VOS_VAULT_ROOT    = vaultRoot
```

### 3.4 PreToolUse hook decision

Algorithm (Bun script, ~80 lines):

```
input = JSON.parse(stdin)
tool  = input.tool_name
args  = input.tool_input

classify(tool):
  WRITE_TOOLS = { Edit, Write, MultiEdit }
  READ_TOOLS  = { Read, Glob, Grep }
  if tool in WRITE_TOOLS:
    paths = [args.file_path]
    return gateWrite(paths)
  if tool in READ_TOOLS:
    paths = [args.file_path ?? args.pattern ?? args.path]
    return gateRead(paths)
  if tool == "Bash":
    cmd = args.command
    { reads, writes } = parseShellPaths(cmd)
    if writes.length: gateWrite(writes); if denied return
    if reads.length:  gateRead(reads)
    return allow
  return allow   // unknown tool: out of scope, defer to other layers

gateRead(paths):
  for p in paths:
    abs = resolveAbs(p, cwd=$VOS_VAULT_ROOT)
    if !matchesAny(abs, $VOS_READ_PATHS):
      return { continue: false, stopReason: `READ_SCOPE_DENIED: ${rel(abs)} outside read_scope` }
  return { continue: true }

gateWrite(paths):
  for p in paths:
    abs = resolveAbs(p, cwd=$VOS_VAULT_ROOT)
    if matchesAny(abs, $VOS_SYSTEM_DENY):
      return { continue: false, stopReason: `SYSTEM_DENY: ${rel(abs)}` }
    if !matchesAny(abs, $VOS_WRITE_PATHS):
      return { continue: false, stopReason: `WRITE_SCOPE_DENIED: ${rel(abs)} outside write_scope` }
  return { continue: true }
```

`parseShellPaths(cmd)`: a deliberately narrow shell-arg parser using `parse-cmd` (already in daemon deps? — confirm in plan T0). Conservative: any unrecognized leading verb → return `{ reads: [cmd-as-path], writes: [] }` which forces the read gate to evaluate, denying anything outside `readPaths`. The list of recognized verbs:

- read-like: `cat head tail less more ls grep rg find file stat wc git-show git-log`
- write-like: `mv cp rm tee sed sd touch mkdir rmdir git-add git-mv git-rm git-commit`
- redirect: any `>` / `>>` / `tee` → target is the post-redirect path

Bash patterns the agent can issue safely without paths (`git status` with no `--`, `pwd`, `echo`, `date`) → allow.

### 3.5 vault.read identity flow

The MCP server is currently constructed per request (`mountMcp` builds a fresh `McpServer` inside `app.all("/mcp")`). VOS-106 extends the route to:

1. Parse `c.req.query("agent")` and `c.req.query("run")`.
2. Resolve `agentDefn = loadAgentDefn(agentName)` (already a dep).
3. Pass `agentDefn` + `engine` into `makeVaultRead({ vaultRoot, db, engine, agent: agentDefn })`.
4. `ask_agent` already receives `loadAgentDefn` — its handler still uses `_meta` for the caller's identity per VOS-89 wiring. URL-query identity supplements but does not replace `_meta`.

A spawned agent's MCP URL is therefore unique per spawn (`?agent=maya&run=<runId>`). Two parallel chats by maya get distinct `run` IDs, identical `agent` slugs — consistent with engine semantics (scopes are per-agent, not per-run).

### 3.6 SQLite migration

`0010_runs_scopes.sql`:

```sql
ALTER TABLE runs ADD COLUMN scopes_json TEXT;
```

Spawner writes the resolved scopes as `JSON.stringify({readPaths, writePaths})` at INSERT time. Pre-VOS-106 runs leave NULL. Reads are advisory (debugging, trace post-mortem); no consumer reads this column in v1.

## 4. Failure modes

| Scenario | Behavior |
|---|---|
| Agent has no `agent_cards` row | `loadAgentDefn` throws `unknown agent`. Spawner converts to `run.error` and emits before exit. |
| `resolveScopes` throws `ZeroScopeError` | Same path: spawner fails the spawn with the engine reason in `runs.error`. |
| Hook script not found at runtime path | CC reports the hook failure; PreToolUse hooks that error are treated as deny by CC. Spawner logs and the run continues to produce a tool-denied response. |
| `--mcp-config` URL unreachable (daemon crashed mid-spawn) | CC reports MCP connection error; tool listing still includes native tools. Tests should expect this and report `MCP_UNREACHABLE` distinct from a scope deny. |
| Bash command with shell substitution (`$(...)`, backticks) | Conservative deny. The pattern is rare in agent prompts; if it surfaces in dogfood, VOS-107 widens the parser. |
| Agent settings overlap with `additionalDirectories` paths inside vaultRoot | `buildSpawnSettings` filters readPaths to keep only paths NOT under vaultRoot for the `additionalDirectories` list (CC's cwd already covers in-vault paths). PreToolUse still gates the subtree. |

## 5. Testing

### 5.1 Unit
- `spawn-settings.test.ts` — fixtures of `(AgentDefn, ResolvedScopes) → JSON files`. Asserts hook env, additionalDirectories, mcpServers URL.
- `pre-tool-use.test.ts` — table-driven over `(envScopes, toolCall) → decision`. Covers Read/Glob/Grep/Bash/Edit/Write/MultiEdit and SYSTEM_DENY.
- `parse-shell-paths.test.ts` — Bash classifier table: `cat vault/journal/X.md → reads=[vault/journal/X.md]`, `echo hi > vault/note.md → writes=[vault/note.md]`, `unknown-cmd foo bar → reads=[unknown-cmd foo bar]` (conservative).
- `vault-read-scope.test.ts` — extends existing vault-read tests with engine-deny case.

### 5.2 Integration
- `cc-spawner.loader-integration.test.ts` — boot daemon against scratch vault with fake provider; assert per-run `<runId>.settings.json` + `<runId>.mcp.json` files exist with expected shape after spawn.
- `mcp-vault-read-scope.test.ts` — POST /mcp?agent=journaler with `vault.read({path:"work/tasks/active/X.md"})` → `SCOPE_DENIED`.

### 5.3 Probe (six-probe replay)
`daemon/test/probes/loader-integration.ts`:
- Pre-flight: `readdirSync('<vault>/work/tasks/backlog')` → pick first `VOS-*-*.md`, extract ID. Substitute into tt-promote probe regex.
- Spin live daemon (already-existing test harness in `daemon/test/manual-e2e.md`), real `claudev claude` provider.
- Run six probes serially (each is its own chat). Capture reply text.
- Print table; exit 1 if strict-pass < 5.
- Wrapped in `daemon/test/probes/README.md` with explicit "this is an e2e probe, not a unit test; skipped in CI by default; run via `bun test:probes`".

## 6. Out of scope (deferred to VOS-107+)

- `vault.write` / `vault.append` MCP tools (VaultWriter wrap). VOS-106 gates `vault.read` only; writes still go through CC's native Edit/Write which the PreToolUse hook covers.
- `_meta.agent_name` MCP propagation from CC client side. URL-query identity is sufficient for VOS-106 because the daemon controls the URL it hands to CC.
- Live MCP-server filtering per agent (hiding `ask_agent` based on `ask_agent_allow` at listTools time). Current behavior: tool is listed; the tool handler enforces `ask_agent_allow` per call (VOS-89).
- Bash shell substitution / pipeline parsing beyond conservative deny.

## 7. Plan phasing (for writing-plans)

Suggested phasing:

1. **T1** — Engine wiring in `app.ts` + factory + spawner deps. No CC arg changes yet. (Setup.)
2. **T2** — `spawn-settings.ts` + per-run files written to disk on spawn. Argv extension. Migration 0010. (Spawn-time plumbing.)
3. **T3** — `pre-tool-use.ts` hook script + unit tests + shell-arg classifier. (Decision engine.)
4. **T4** — `--mcp-config` wiring + URL-query identity in `mountMcp`. (MCP reachability.)
5. **T5** — `vault.read` scope gate. (Read backdoor closure.)
6. **T6** — Probe harness promotion + dynamic backlog pick. (Verification surface.)
7. **T7** — Six-probe re-run; ≥5/6 strict pass. Code review gate. (Acceptance.)

T1-T5 are unit-testable in isolation and run in parallel between subagents where dependencies allow (T3 has no dep on T2's argv plumbing; both feed into T7).

## 8. Open questions / known unknowns

- **CC SDK shape of PreToolUse decision JSON.** Spec assumes `{continue: bool, stopReason?: string}`. Plan T3 must confirm against the live `claude` binary version pinned by `claudev`. If shape differs, the hook script's output adapts; no other layer is affected.
- **Whether `--mcp-config` accepts http URLs in the streamable-http transport mode.** Daemon mounts at `/mcp` via `StreamableHTTPServerTransport`. CC's `--mcp-config` historically supported stdio + http; plan T4 verifies the URL form works (alternative: spawn a per-run stdio shim that proxies to the daemon's `/mcp` — adds a process, avoids if possible).
- **Concurrent spawns + URL identity.** Two parallel maya chats both hit `/mcp?agent=maya&run=<distinct>`. The MCP `_meta` for `ask_user` / `ask_agent` already carries `run_id`. No conflict expected; flagged for plan-time confirmation.
