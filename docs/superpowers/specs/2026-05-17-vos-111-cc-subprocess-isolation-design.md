# VOS-111 — Isolate spawned Claude Code subprocess from operator's global config

**Status:** design
**Date:** 2026-05-17
**Task:** [VOS-111](../../../../vault/work/tasks/active/VOS-111-isolate-claude-code-subprocess-from-user-config.md)
**Parent:** VOS-107 (the trace that exposed the leak)

## Problem

The void-os daemon spawns `claudev claude` via `daemon/src/providers/claude-code/index.ts`. The spawn passes `process.env` whole to the child, so the operator's `HOME` reaches CC and CC reads `~/.claude/` for plugins, MCP servers, slash commands, and user settings.

VOS-107 manual trace captured the leak: maya's session listed `playwright`, `context7`, `plugin:context-mode:context-mode` as MCP servers and `Task`, `EnterPlanMode`, `CronCreate`, `ToolSearch`, `RemoteTrigger`, `ScheduleWakeup` among tools — none of which are vault-defined.

Effects:
- Agent behavior diverges per operator. CI / headless hosts get a *different* maya than a developer's Mac.
- Untrusted MCP servers in any operator's personal config become reachable from every agent.
- The void-os scope-enforcement story is undermined: a `Task` invocation spawns a sub-CC outside the daemon's PreToolUse hook entirely.

## Goal

After this change, a spawned CC subprocess loads only configuration the vault authored. Operator-personal `~/.claude/` content has no effect on agent behavior.

## Non-goals

- Not modifying claudev. Its `$HOME/.claudev/token` OAuth path stays intact.
- Not stripping/rebuilding the child env. `CLAUDE_CODE_OAUTH_TOKEN`, `HOME`, `XDG_*` remain as inherited from the daemon's environment.
- Not introducing a sandboxed `CLAUDE_CONFIG_DIR` directory. The CLI flags below are sufficient.

## Mechanism

Extend the existing argv built in `daemon/src/providers/claude-code/index.ts` (line ~269) with three flags:

| Flag | Effect |
|---|---|
| `--strict-mcp-config` | CC honors only the MCP servers passed via `--mcp-config <our.json>`. Operator-installed MCPs (playwright, context7, plugin:context-mode, anything else) are ignored. |
| `--setting-sources project` | CC loads only project-level settings. The `user` source (operator's `~/.claude/settings.json`, including its `enabledMcpjsonServers`, `permissions`, `hooks`, allowlists, etc.) is not loaded. Our per-run `--settings <p>` flag is still honored — it is a flag-level injection, not a source. |
| `--tools <comma-list>` | Explicit allowlist of tools available to the agent. Built-ins not on the list (e.g. `Task`, `EnterPlanMode`, `ScheduleWakeup`) cannot be called. |

The env passed to `Bun.spawn` is left as `{ ...process.env, ...hookEnv }` — claudev's OAuth fetch and our PreToolUse hook both depend on env vars (`CLAUDE_CODE_OAUTH_TOKEN`, `VOS_*`), and the CLI flags above are precise enough that env manipulation is unnecessary.

## Allowlist

Exported from `daemon/src/providers/claude-code/spawn-settings.ts` as `ALLOWED_TOOLS: readonly string[]`:

```
Bash
Edit
Read
Write
Grep
Glob
NotebookEdit
NotebookRead
TodoWrite
WebFetch
WebSearch
mcp__void-os__vault_read
mcp__void-os__ask_user
mcp__void-os__ask_agent
```

**Excluded** built-ins (must not appear in the agent's tool listing): `Task`, `EnterPlanMode`, `ExitPlanMode`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `PushNotification`, `Monitor`, `Skill`, `ToolSearch`.

Rationale:
- `Task` would spawn a sub-CC outside the daemon's orchestration and PreToolUse hook.
- Plan-mode, cron, schedule, remote-trigger, push tools are harness/operator features with no place in a non-interactive agent.
- `Skill` and `ToolSearch` re-open the operator-config channel by resolving names against the operator's `~/.claude/plugins/` and deferred-tool registries.

The MCP tool names use CC's MCP naming convention (`mcp__<server>__<tool>` with `.` → `_`). The exact form is pinned by a T0 probe before this design is implemented (see Task T0 in the plan).

## Change surface

| File | Change |
|---|---|
| `daemon/src/providers/claude-code/spawn-settings.ts` | Export `ALLOWED_TOOLS`. |
| `daemon/src/providers/claude-code/index.ts` | Extend `args` (≈line 269) with `--strict-mcp-config`, `--setting-sources`, `project`, `--tools`, `ALLOWED_TOOLS.join(",")`. |
| `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts` | Pin `ALLOWED_TOOLS` contents (snapshot). |
| `daemon/test/cc-spawner.integration.test.ts` | New case: argv contains the three new flags + the joined allowlist. fake-claudev echoes argv. |
| `daemon/test/smoke.test.ts` | Opt-in real-claudev smoke: parse first `system` event, assert `mcp_servers === ["void-os"]` and `tools ⊆ ALLOWED_TOOLS`. |
| `daemon/test/probes/isolation-probe.ts` | New, committed manual probe. Spawns one real CC with the new flags against a no-op vault, prints `mcp_servers` + `tools`. Documented in `daemon/test/probes/README.md`. |

claudev is untouched. No env changes.

## Test strategy

1. **T0 probe** (manual, runs once before pinning the allowlist). `daemon/test/probes/isolation-probe.ts` spawns real CC with the new flags + a minimal `--mcp-config` pointing at the void-os daemon. Captures the first `system` event and prints `mcp_servers`, `tools`. Operator runs the probe, confirms exact MCP tool name form, pastes results into the spec / plan, then the `ALLOWED_TOOLS` constant is finalized.
2. **Unit:** `spawn-settings.test.ts` pins `ALLOWED_TOOLS` contents. Failing this test means a contributor added/removed a tool without spec review.
3. **Integration (fake-claudev):** assert argv contains the three flags and the joined allowlist string. fake-claudev does not implement MCP discovery, so this test verifies wiring only — not runtime effect.
4. **Smoke (real-claudev, `SMOKE=1`):** parse the system event's `mcp_servers` and `tools` arrays. Assert `mcp_servers === ["void-os"]` and `tools.every(t => ALLOWED_TOOLS.includes(t))`. Acceptance bullets 3 + 4 of the task.
5. **VOS-107 e2e scan:** check `daemon/test/manual-e2e.md` and any VOS-107-related spec for assertions that relied on leaky behavior. None expected, but acceptance bullet 5 requires the scan.
6. **Forward-drift guard:** unit test in `adapters/mcp/__tests__/registered-tools.test.ts` that enumerates registered MCP tools and fails if any registered tool is missing from `ALLOWED_TOOLS`. Prevents the case where someone adds a new vault MCP tool but forgets to expose it to agents.

## Risks + decisions

1. **`<vault>/.claude/settings.json` leak.** `--setting-sources project` still loads project-level settings if a `.claude/settings.json` exists at `req.cwd`. **Decision:** log a warning at boot if such a file exists at the vault root; do not block. Vault-authored project settings are intentional. (Subtask: T7 in the plan adds the boot-time audit log.)
2. **MCP tool name form.** Whether CC emits `mcp__void-os__vault_read` or `mcp__void-os__vault.read` for the registered `vault.read` is pinned by T0. Until pinned the allowlist is provisional.
3. **Forward drift.** New void-os MCP tools must be added to `ALLOWED_TOOLS`. The registered-tools guard test (T-Forward) ensures the omission fails CI rather than silently denying agents access.
4. **New CC harness tools.** If CC ships a new built-in (e.g. a future `BackgroundAgent`), agents will not gain access until `ALLOWED_TOOLS` is updated. This is the intended posture — explicit allowlist over implicit inclusion.

## Acceptance (from task file, restated)

- [x] Spawned CC subprocess loads only `--mcp-config`-defined MCP servers + an explicit tool allowlist; operator's `~/.claude/` does not influence the spawn. *(Verified by smoke test + manual probe.)*
- [x] Mechanism: CLI flags (`--strict-mcp-config` + `--setting-sources project` + `--tools <allowlist>`); no env tampering, no sandboxed config dir.
- [x] Trace `mcp_servers` after fix lists only `void-os`. *(Smoke + probe.)*
- [x] Trace `tools` lists only Claude built-ins on the allowlist + `mcp__void-os__*`. *(Smoke + probe.)*
- [x] VOS-107 e2e scanned; updated if needed. *(Subtask T-VOS107.)*

(Boxes checked indicate "spec covers this acceptance criterion" — runtime verification ticks happen in the plan/execution phase.)

## Open items resolved during implementation

- T0 outputs feed into `ALLOWED_TOOLS`.
- T7 confirms whether vault root has a stray `.claude/settings.json`.
