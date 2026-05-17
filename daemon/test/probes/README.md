# daemon/test/probes

End-to-end probes that spin a live in-process daemon and run **real** Claude
Code subprocesses via `claudev`. Not unit tests. Not part of `bun test`.
Run them explicitly:

    bun test:probes

## vos-111-isolation-probe.ts (VOS-111)

Manual one-shot probe that pins three pre-implementation unknowns for the
CC-subprocess-isolation work (VOS-111):

- **A** — flag syntax for `--setting-sources`, `--strict-mcp-config`, `--tools`
  on the pinned `claudev` version (see `daemon/package.json` `voidos`).
- **B** — exact MCP tool name CC emits for `vault.read` registered on
  McpServer `void-os` (drives the `mcpToolNameFor` transform in T1).
- **C** — that `--settings <p>` is still honored when `--setting-sources` is
  pinned to `project` (i.e. drops `user`-scope settings). Proved via a
  PreToolUse side-channel hook that appends to `/tmp/probe-hook.log`.

Run:
```
bun daemon/test/probes/vos-111-isolation-probe.ts
```

Outputs go to stdout in three blocks (§B mcp_servers / tools, §C hook log).
Recorded results live in `vos-111-isolation-probe.md` alongside the driver.

Cost: one short claudev/Claude Code turn per run (pennies on the operator's
pool token). NOT part of `bun test`.

## loader-integration.ts (VOS-106)

Six cross-agent routing probes against a fixture vault at
`daemon/test/fixtures/probe-vault/`. Pass when ≥5/6 strict-match the
expected behavior (the `expectRegex` per probe). The single permitted
non-pass is `PROBE_DESIGN_BUG` (harness error, not a routing regression).

Each probe creates a fresh chat for a starter-vault agent and asks a
question that exercises a cross-agent boundary. Expected behavior is that
the agent surfaces `ask_agent("<peer>", ...)` rather than reaching for
`Read` directly. The PreToolUse hook (VOS-106) is what makes this work —
without it, agents have full default tool access and bypass the routing.
