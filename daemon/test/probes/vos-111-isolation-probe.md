# VOS-111 isolation probe runbook

Pinned CC: claudev 0.2.18 / Claude Code 2.1.143 (from `daemon/package.json` `voidos` block)
Pinned daemon commit: hub-task/VOS-111 worktree at /Users/admin/hub-wt/VOS-111
Operator: shadeoflance
Date: 2026-05-17

## Sub-assertion A: flag syntax

Command:
```
claudev claude --help 2>&1 | grep -E 'strict-mcp-config|setting-sources|tools' | sed 's/^  *//'
```

Output (verbatim, ignoring claudev banner lines):
```
--allowedTools, --allowed-tools <tools...>        Comma or space-separated list of tool names to allow (e.g. "Bash(git *) Edit")
--disallowedTools, --disallowed-tools <tools...>  Comma or space-separated list of tool names to deny (e.g. "Bash(git *) Edit")
--setting-sources <sources>                       Comma-separated list of setting sources to load (user, project, local).
--strict-mcp-config                               Only use MCP servers from --mcp-config, ignoring all other MCP configurations
--tools <tools...>                                Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").
```

All three required flags present on pinned version 0.2.18:
- `--strict-mcp-config` — boolean, no value.
- `--setting-sources <sources>` — single argument, comma-separated string. Allowed values per help: `user, project, local`.
- `--tools <tools...>` — variadic (`<tools...>`) but help example uses the comma-string single-token form (`"Bash,Edit,Read"`). VOS-111 T1 will use the comma-joined single-token form so it parses identically under either reading.

Recorded `--setting-sources` value form: **single value, comma-separated string** (one positional after the flag, e.g. `--setting-sources project` or `--setting-sources project,local`).

Recorded pinned value for VOS-111: `project` (drops `user` — the operator's `~/.claude/settings.json` — and `local` — repo-local `.claude/settings.local.json`. Keeps `<vault>/.claude/settings.json` as the only ambient project-scope surface, which T5 audits at boot.)

→ **A PASS**.

## Sub-assertion B: MCP tool name form

Run:
```
cd /Users/admin/hub-wt/VOS-111/workspace/void-os && bun daemon/test/probes/vos-111-isolation-probe.ts
```

Captured `mcp_servers` (verbatim from probe stdout § B):
```
[
  {
    "name": "void-os",
    "status": "connected"
  }
]
```

Captured `tools` array (verbatim from probe stdout § B — observation mode, NO `--tools` flag passed):
```
[
  "Task",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "Read",
  "RemoteTrigger",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
  "mcp__void-os__ask_agent",
  "mcp__void-os__ask_user",
  "mcp__void-os__vault_read"
]
```

`mcp__void-os__*` subset:
```
[
  "mcp__void-os__ask_agent",
  "mcp__void-os__ask_user",
  "mcp__void-os__vault_read"
]
```

Findings:
- Exact MCP tool name form: `mcp__<server>__<tool>`, with `.` rewritten to `_`. Confirms `vault.read` (registered as `vault.read` on McpServer `void-os`) is emitted as `mcp__void-os__vault_read`. Drives `mcpToolNameFor(server, tool) = "mcp__" + server + "__" + tool.replace(/\./g, "_")` in T1.
- `--strict-mcp-config` works as the spec assumed: only `void-os` appears in `mcp_servers`. NO operator-installed servers (no `playwright`, no `context7`, no `plugin:context-mode`) leak through.
- `tools` array shows the unrestricted CC built-in surface (no `--tools` flag passed in T0, by design — observation mode). Surface leaks include: `Task`, `CronCreate`, `CronDelete`, `CronList`, `EnterPlanMode`, `EnterWorktree`, `ExitPlanMode`, `ExitWorktree`, `Monitor`, `PushNotification`, `RemoteTrigger`, `ScheduleWakeup`, `Skill`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`, `ToolSearch`, `NotebookEdit`, `WebFetch`, `WebSearch`. T1's `ALLOWED_TOOLS` whitelist trims to the pinned set in spec §3.

Note for T1: the plan's nominal `ALLOWED_TOOLS` list does NOT include `MultiEdit`, `NotebookRead`, or `TodoWrite` in this captured output. The spec-pinned list (Bash, Edit, MultiEdit, Read, Write, Grep, Glob, NotebookEdit, NotebookRead, TodoWrite, WebFetch, WebSearch) is a SUPERSET of what CC 2.1.143 actually emits here for the missing three. Passing names that CC does not expose is harmless — CC ignores unknown allowlist entries. T1 implementer may keep the spec list as-is or trim; either is defensible. Recommend keeping the spec list for forward-compat across CC minor versions.

→ **B PASS**.

## Sub-assertion C: --settings still honored under --setting-sources project

Side-channel: PreToolUse hook script at `<probeDir>/hook.sh` writes one line to `/tmp/probe-hook.log` per CC tool call.

Probe was invoked with prompt: "You MUST call the Bash tool exactly once with command `ls`. Do not answer textually. After the tool returns, stop." The model first reached for `Read` (auto-memory lookup) — that call hit the PreToolUse hook before any other tool.

Output (verbatim from probe stdout § C):
```
tool_use blocks observed in assistant messages: 1
  - Read: {"file_path":"/Users/admin/.claude/projects/-private-var-folders-ld-nkxgmqj50854-0pq4dk3ck0m0000gn-T-vos-111-probe-vault-Q6S3zA/memory/MEMORY.md"}

HOOK FIRED — contents of /tmp/probe-hook.log:
HOOK_FIRED Read 2026-05-17T13:48:05Z
```

At least one `HOOK_FIRED` line present. The PreToolUse hook supplied via `--settings <p>` fires even when `--setting-sources project` is set (which excludes `user`-scope settings entirely). Confirms the spec's load-bearing assumption: `--settings` is processed independently of `--setting-sources`, so the daemon's per-spawn hook injection survives the new isolation flags.

(Aside: the hook matcher in `buildSpawnSettings` covers `Read|Glob|Grep|Bash|Edit|Write|MultiEdit`, so the Read invocation matches and the hook fires. Bash never got called because Read returned content the model decided to act on textually instead — the PreToolUse contract is unchanged either way: the matcher matched, the command ran, evidence written to side-channel.)

→ **C PASS**.

## Outcome

- [x] A passed (flag syntax recorded — three-flag set present, `--setting-sources` is single comma-string arg)
- [x] B passed (MCP tool name form recorded — `mcp__<server>__<tool.replaceAll(".","_")>`; full leaked-tool list captured for T1 to whitelist down)
- [x] C passed (PreToolUse hook fired on `Read` despite `--setting-sources project`; `--settings` is honored independently)

T0 gate: **OPEN**. Proceed to T1.

## Forensic artefacts

- Probe driver: `daemon/test/probes/vos-111-isolation-probe.ts` (committed)
- Side-channel hook output (this run): `/tmp/probe-hook.log` (overwritten on each probe run)
- Full stream-json log (per-run, kept on disk for inspection): `<tmpdir>/vos-111-probe-*/stream-json.log` (path printed at start of probe run)
- Settings + mcp config written by probe (per-run): `<tmpdir>/vos-111-probe-*/settings/probe-run.{settings,mcp}.json`

## Reproducibility

Run from worktree root:
```
cd /Users/admin/hub-wt/VOS-111/workspace/void-os
bun daemon/test/probes/vos-111-isolation-probe.ts
```

Cost per run: one short claudev/Claude Code turn (single tool call), pennies on the operator's pool token.

If `SETTING_SOURCES_FLAGS` in the driver needs to change (e.g. new claudev version changes the value form), edit the constant at the top of `vos-111-isolation-probe.ts` and rerun. The runbook §A must be updated accordingly.
