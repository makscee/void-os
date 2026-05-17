---
task: VOS-112
title: stdio MCP bridge for production CC subprocess
created: 2026-05-17
status: draft
---

# VOS-112 — stdio MCP bridge for production CC subprocess

## Problem

`vos_ask_user` (and the same-shaped `vos_ask_agent`) reads runtime ids (`task_id`, `context_id`, `run_id`) from `extra._meta` per ADR-0002. The fake provider sets these explicitly in `params._meta` when POSTing to the daemon's HTTP `/mcp`. **Production CC subprocesses do not** — CC's MCP HTTP client has no API surface for setting `_meta` on outbound tool calls, and CC's `mcp.json` `headers` field is known-broken in current releases (anthropics/claude-code#28293, #29562, #7290, #51581, #14977, #17069). The spawned CC therefore calls `ask_user` with no `_meta.task_id`, the handler returns `ASK_USER_MISSING_TASK_ID`, and the dispatch errors out (surfaced in VOS-107 manual UX).

VOS-107's prompt-cache fix removed `&run=<runId>` from the MCP URL and intentionally left **only** `?agent=<name>` — so no run-scoped identity travels over HTTP today. The daemon also has no record-locator to map an incoming MCP call back to a specific in-flight task: a single agent can have concurrent dispatches across different chats, and the URL is identical for all of them.

## Decision

Replace the HTTP MCP transport on the **production CC spawn path** with a per-spawn **stdio MCP bridge**. The bridge is a tiny daemon-owned proxy launched by CC as a stdio MCP server; it reads runtime ids from its own environment (which the daemon sets per spawn) and stamps `params._meta` on every forwarded `tools/call` JSON-RPC request before relaying to the daemon's existing HTTP `/mcp` route.

This makes ADR-0002's `_meta` channel real in production without changing tool handlers, without depending on HTTP-transport quirks of any specific CLI, and without polluting URLs or tool arguments. It is also the most provider-portable surface — stdio is the universal MCP transport, so future provider swaps (Codex CLI, Gemini CLI, any custom subprocess) reuse the same bridge unchanged.

The HTTP `/mcp` route is **not removed**: the fake provider's e2e path keeps stamping `_meta` directly via HTTP, admin/dev tooling can keep using it, and the bridge itself targets it as its upstream. The change is strictly additive — the production CC adapter swaps the URL-based mcp.json for a command-based one.

## Architecture

### Components

```
+----------------------------+         stdio JSON-RPC         +------------------------------+
| CC subprocess              | <----------------------------> | mcp-stdio-bridge.ts          |
| (mcp.json points at bridge)|                                | (Bun process per CC spawn)   |
+----------------------------+                                +------------------------------+
                                                                       |
                                          POST /mcp?agent=<env.VOS_AGENT>  (params._meta stamped)
                                                                       v
                                                              +------------------------------+
                                                              | daemon HTTP /mcp (Hono)      |
                                                              |  unchanged handler path:     |
                                                              |  loadAgentDefn → buildMcp → │
                                                              |  registerTool → extra._meta  |
                                                              +------------------------------+
```

One CC spawn produces one bridge subprocess that lives for the life of that CC run. Concurrent dispatches against the same agent in different chats get separate bridge processes with separate env → fully disjoint task identity.

### Files

| Path | Action | Purpose |
|---|---|---|
| `daemon/src/adapters/mcp/stdio-bridge.ts` | **new** | Bridge entrypoint. Reads env, runs stdio MCP loop, stamps `_meta`, POSTs to daemon HTTP `/mcp`. |
| `daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts` | **new** | Unit tests for the bridge (env stamping, passthrough, error mapping). |
| `daemon/src/providers/claude-code/spawn-settings.ts` | edit | Replace HTTP `mcp.json` shape with stdio `{command, args, env}`. Drop URL building from this file. |
| `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts` | edit | Replace URL-shape assertions with stdio-shape assertions. |
| `daemon/src/providers/claude-code/index.ts` | edit | Pass `taskId`, `contextId`, `runId` into `buildSpawnSettings`. Resolve absolute bridge path once at module init via `import.meta.url`. |
| `daemon/src/providers/claude-code/provider.ts` | edit | Thread `taskId` into the spawner args (already on `ProviderSpawnRequest`). |
| `daemon/test/integration/stdio-bridge-e2e.test.ts` | **new** | Integration: spawn real bridge against running daemon, call `ask_user`, assert handler sees env-derived `task_id`. |
| `daemon/src/adapters/mcp/index.ts` | **no change** | HTTP route stays. No new identity channel. |
| `daemon/src/adapters/mcp/tools/ask-user.ts` | **no change** | Reads `_meta.task_id` as before. |
| `daemon/src/adapters/mcp/tools/ask-agent.ts` | **no change** | Reads `_meta.task_id` as before. |
| `daemon/src/providers/fake/index.ts` | **no change** | Keeps direct-HTTP path with `_meta` stamped client-side. |

### Bridge data flow

The bridge is a stateless proxy. On startup:

1. Read env: `VOS_DAEMON_BASE` (required), `VOS_AGENT` (required), `VOS_TASK_ID` (required), `VOS_CONTEXT_ID` (optional, defaults to `VOS_TASK_ID`), `VOS_RUN_ID` (optional, may be empty). Missing required vars → write a JSON-RPC `error` envelope to stdout and exit 1 (fail-fast; surfaces as CC `mcp_servers[void-os].status="failed"`).
2. Frame stdin/stdout using **the official `@modelcontextprotocol/sdk` stdio transport on both legs** — never hand-roll newline splitting. Concretely: the bridge constructs a `StdioServerTransport` (stdin/stdout from the parent CC subprocess) and a corresponding client-side transport that POSTs each parsed JSON-RPC envelope upstream. The SDK transport handles buffering, partial reads, embedded newlines inside string payloads, and the JSON-RPC envelope boundary. Hand-rolled `split('\n')` corrupts any tool result that contains literal newlines (every `vault.read` of a multi-line file, every multi-line `ask_user` answer, every multi-line agent reply via `ask_agent`) and the failure is opaque ("MCP tool call failed" with no stack). Out-of-spec.
3. For each request:
   - `initialize`, `notifications/*`, `ping`, `tools/list`, `resources/*`, `prompts/*` → forward verbatim. No `_meta` injection. Pass through response.
   - `tools/call` → before forwarding, set
     ```
     request.params._meta = {
       ...request.params._meta,            // preserve client-provided fields
       task_id:    env.VOS_TASK_ID,
       context_id: env.VOS_CONTEXT_ID,
       ...(env.VOS_RUN_ID ? { run_id: env.VOS_RUN_ID } : {}),
     }
     ```
     Spread order is intentional: any field the model set on `_meta` is preserved if and only if it has no daemon-stamped counterpart (e.g. `_vos_tool_use_id`). The three daemon-controlled fields (`task_id`, `context_id`, `run_id`) always win over whatever the model wrote there.
4. POST to `${VOS_DAEMON_BASE}/mcp?agent=${encodeURIComponent(VOS_AGENT)}` with `Content-Type: application/json`. Use `fetch` from Bun (or the built-in `node:http` for portability — fetch is fine, the daemon is loopback).
5. Stream response body back to stdout. Daemon `/mcp` returns JSON-RPC envelopes; bridge echoes them line-by-line.
6. Network errors → emit a JSON-RPC `error` response with code `-32603` (internal error) and `data: { kind: "BRIDGE_UPSTREAM_FAIL", message }`. Do not retry — CC's own tool-call retry / user surfacing is the right place.

### Spawn-settings change

Before:
```ts
const mcp = {
  mcpServers: { "void-os": {
    type: "http",
    url: `${daemonBase}/mcp?agent=${encodeURIComponent(agentName)}`,
  }},
};
```

After:
```ts
const mcp = {
  mcpServers: { "void-os": {
    type: "stdio",
    command: BUN_PATH,            // process.execPath — survives systemd / launchd
    args: [BRIDGE_PATH],          // absolute, resolved once at daemon boot
    env: {
      VOS_DAEMON_BASE: daemonBase,
      VOS_AGENT:       agentName,
      VOS_TASK_ID:     taskId,
      VOS_CONTEXT_ID:  contextId,
      ...(runId ? { VOS_RUN_ID: runId } : {}),
    },
  }},
};
```

`BuildSpawnSettingsArgs` gains `taskId: string`, `contextId: string`, `runId: string` and loses nothing. The `agentName` + `daemonBase` args stay (still needed for the bridge env). `mcpConfigPath` shape is otherwise identical (still a per-`runId` file under `tracesDir`).

### Bridge entrypoint resolution

`stdio-bridge.ts` lives in the daemon source tree, so it ships with the daemon by construction (per ADR-0003 the daemon runs from source). One-time resolution at the top of `providers/claude-code/index.ts`:

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// From daemon/src/providers/claude-code/index.ts → daemon/src/adapters/mcp/stdio-bridge.ts.
// `import.meta.dir` is the Bun shorthand for the directory of this module.
const BRIDGE_PATH = resolve(
  import.meta.dir, "..", "..", "adapters", "mcp", "stdio-bridge.ts",
);
if (!existsSync(BRIDGE_PATH)) {
  throw new Error(`stdio-bridge.ts not found at ${BRIDGE_PATH}`);
}

// Absolute Bun binary path — survives PATH-less launchers (systemd, launchd,
// packaged binaries). String "bun" fails under any process supervisor that
// doesn't carry the user shell PATH.
const BUN_PATH = process.execPath;
```

Hot-reload friendly: any code change in the daemon picks up on next spawn (the bridge is a fresh `bun` process each time).

### What stays exactly the same

- The HTTP `/mcp` route, its `?agent=<name>` query, `loadAgentDefn`, `buildMcpServer`, all three `mcp.registerTool` calls, and every tool factory (`makeVaultRead`, `makeAskUser`, `makeAskAgent`).
- ADR-0002's contract that runtime ids live in `_meta` (now genuinely satisfied at the wire for production CC).
- The fake provider's existing JSON-RPC body that already stamps `_meta` and POSTs `/mcp` directly.
- `--strict-mcp-config`, `--setting-sources project`, `--tools` whitelist (the `mcp__void-os__*` names are unchanged).
- Prompt-cache stability: the bridge `command`+`args` are identical across runs; only `env` varies, and MCP clients fingerprint servers by command/args, not env.

### What changes for callers

- `provider.spawn` already receives `taskId`, `contextId`, `runId` on `ProviderSpawnRequest` — no signature change.
- CC `index.ts` threads them through to `buildSpawnSettings`.
- The `cc-spawner-loader.test.ts` MCP-URL fixture flips to a stdio fixture.

## Acceptance criteria

(Mirrors the task file, plus the gates each subtask must hit.)

1. **AC-1 — Production CC reaches `ask_user` with correct `task_id`.** A real CC subprocess spawned by the daemon calls `mcp__void-os__ask_user`. The daemon's handler receives `extra._meta.task_id` equal to the orchestrator's `taskId` for that run. No `ASK_USER_MISSING_TASK_ID` error. Verified by: integration test (`stdio-bridge-e2e.test.ts`) + a one-shot manual repro of the VOS-107 UX path.
2. **AC-2 — `vos_ask_agent` works on the same path.** Same integration test repeats the assertion for `ask_agent` (it reads `_meta.task_id` at `tools/ask-agent.ts:257`). Handler receives stamped `task_id`.
3. **AC-3 — Fake provider e2e unchanged.** The full e2e suite (`bun test`) passes. Fake provider keeps POSTing `/mcp` directly with `_meta` set in the request body.
4. **AC-4 — Concurrent dispatches don't cross-pollute.** Two simultaneous CC spawns of the same agent against two different tasks must yield two separate `_meta.task_id` values at the handler **and** task-scoped downstream behavior. Integration test: (a) spawn two bridges with different env, assert each handler call sees the correct `task_id`; (b) park an `ask_user` against task A, fire a /chat/:id/answer resolve for task A, assert task B's separately-parked `ask_user` is **not** unblocked — i.e. the resolution path keys on `task_id` (or `_vos_tool_use_id`), not on `agent`. Catches a wrong-task answer-delivery bug where two concurrent maya runs in different chats would cross-resolve.
5. **AC-5 — Prompt cache stable (dual gate).** (a) **Automated structural** — assert that two consecutive `buildSpawnSettings` calls for the same agent produce byte-equal `command` + `args` in the rendered mcp.json (only `env` differs). This is the only stdio-shape regression class the bridge introduces, since MCP clients fingerprint servers off command+args. (b) **Manual empirical** — drive two real-CC turns of the same task and inspect the turn-2 trace's `assistant.usage` block: `cache_read_input_tokens > 0` AND `cache_creation_input_tokens` near zero (same threshold VOS-107 used). The structural gate catches the bug before merge without paid-API CI; the manual gate confirms no off-the-shape cache-keying field was missed.
6. **AC-6 — Bridge fails fast on misconfig.** Missing required env yields a JSON-RPC error envelope and exit code 1, surfaced to CC as `mcp_servers[void-os].status="failed"` in `system.init`. Verified by unit test.

## Testing strategy

- **Unit (bridge)** — `daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts`. Drive the bridge module in-process with a mock stdin/stdout pair (the SDK transport accepts an injectable `Readable`/`Writable`) and a stub `fetch`. Cover: env stamping on `tools/call`, passthrough on `initialize` / `tools/list`, `_meta` override of model-supplied fields, missing-env error, network-error mapping to `-32603`, **and a payload-integrity case — a `tools/call` response whose `content[0].text` contains literal `\n` characters round-trips through the bridge byte-for-byte (catches any regression to hand-rolled newline splitting).**
- **Unit (spawn-settings)** — extend `spawn-settings.test.ts`. Assert the new mcp.json shape (stdio entry, env contents, bridge path absolute). Replace the URL-shape assertion.
- **Integration** — `daemon/test/integration/stdio-bridge-e2e.test.ts`. Boot the daemon, spawn a real `bun stdio-bridge.ts` subprocess with controlled env, do an `initialize` then `tools/call ask_user`, assert the daemon handler receives the env-derived `task_id`. Concurrent variant: two bridges, two task ids, asserts the handler sees each correctly.
- **e2e (existing)** — full `bun test` must stay green. VOS-107's manual-UX scenario is the acceptance-gate.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| CC stdio MCP entry rejected under `--strict-mcp-config` | low | The MCP-stdio shape is the default in every public CC MCP guide and is what `--strict-mcp-config` is built around. If it does reject, fall back to URL `?task=<id>` (option A) — keep the option in our back pocket; spec change would be a 20-LOC patch. |
| Bridge subprocess leak (CC exits but bridge lingers) | low | CC's stdio MCP lifecycle ties the bridge to CC's own stdin/stdout pipes — when CC exits, the pipes close and the bridge gets EOF, exits cleanly. Bridge also adds a `stdin.on('close', () => process.exit(0))` guard. |
| HTTP route trusts `_meta` from bridge but bridge is untrusted child of CC subprocess (user-process-level boundary) | nil | Bridge runs under the same uid as the daemon-orchestrated spawn; `_meta` stamping happens **inside the bridge** from env the daemon set. The CC subprocess never touches the bridge's env after spawn. No new trust boundary crossed. |
| Daemon ever ships as `bun build --compile` single-file binary | low | Per ADR-0003 the daemon runs from source. The spec ratifies this for VOS-112: `BUN_PATH = process.env.VOS_BUN_PATH ?? process.execPath`. A packaged deploy must export `VOS_BUN_PATH=/path/to/bun` so the bridge launches under a real `bun`, not under the compiled daemon binary. |

## Out of scope

- Removing or deprecating the HTTP `/mcp` route. Stays for fake provider, admin/dev surfaces, and future inbound integrations.
- Migrating the fake provider to stdio. It already stamps `_meta` correctly client-side; flipping it would only add code.
- Implementing additional providers (Codex, Gemini-CLI). The stdio bridge unblocks them; their adapters are separate tasks.
- Reworking ADR-0002. This spec is the unblocking *implementation* of the `_meta` channel ADR-0002 already specified; no ADR change needed.

## Open questions

None. All decisions resolved during brainstorming. Spike-style verifications (CC accepts stdio MCP entry under `--strict-mcp-config`) are baked into the integration test rather than a separate pre-spec spike.
