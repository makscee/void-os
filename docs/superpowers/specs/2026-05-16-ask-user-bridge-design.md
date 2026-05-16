# AskUserBridge — Design

**Task:** VOS-100
**Date:** 2026-05-16
**Status:** approved (brainstorm)

## Problem

`adapters/mcp/tools/ask-user.ts` reaches into `chat/ask-user-repo.ts` for three named CAS helpers (`setTaskInputRequired`, `appendToolUseMessage`, `clearTaskPending`). `adapters/mcp/pending-questions.ts` is a separate in-memory `toolUseId → Promise<answer>` registry, injected as a peer dep into both the MCP tool and `api/answer.ts`. `api/answer.ts` then imports a fourth helper (`appendToolResultMessage`) plus the registry and re-emits its own bus events.

Five files share a single round-trip (`ask_user` MCP tool ↔ HTTP `POST /chat/:id/answer`). No Module owns it. Adding a future tool that pauses on external resolution would copy the same import pattern, deepening the coupling.

`adapters/mcp/tools/ask-agent.ts` was named in the task body but does **not** touch `ask-user-repo.ts`. It uses a different state (`WAITING_ON_AGENT`) and a different resolver (child Task terminal event). Out of scope.

## Decision

Introduce `daemon/src/chat/ask-user-bridge.ts` as the single owner of the *Task pauses for user input → resumes on HTTP answer* round-trip. Delete `chat/ask-user-repo.ts` and `adapters/mcp/pending-questions.ts`; their responsibilities collapse into the bridge.

## Interface

```ts
export interface AskUserBridge {
  // Tool side: register question, flip task → INPUT_REQUIRED, await answer.
  open(args: {
    taskId: string
    contextId: string
    runId: string
    toolUseId: string
    question: string
    options?: string[]
  }): Promise<
    | { answer: string }
    | { canceled: true }
    | { timeout: true }
  >

  // HTTP side: resolve outstanding question, flip task → WORKING, append tool_result.
  resolve(args: {
    taskId: string
    toolUseId: string
    answer: string
  }): Promise<
    | { ok: true }
    | { ok: false; reason: 'unknown' | 'not_pending' }
  >

  // Orchestrator side: clear pending on terminal/cancel.
  cancel(args: {
    taskId: string
    toolUseId: string
    reason: 'terminal' | 'canceled'
  }): Promise<void>
}

export function createAskUserBridge(deps: { db: Database; bus: EventBus }): AskUserBridge
```

## Internals (private)

- In-memory pending registry: `Map<toolUseId, { resolve; reject; deadline }>`. Lives inside the bridge instance — not exported.
- Four CAS / append SQL ops become private methods:
  - `setTaskInputRequired` — atomic CAS UPDATE Task → INPUT_REQUIRED + pending stash
  - `clearTaskPending` — atomic CAS UPDATE Task → WORKING
  - `appendToolUseMessage` — INSERT message with `tool_use` DataPart
  - `appendToolResultMessage` — INSERT message with `tool_result` DataPart
- SQL bodies preserved verbatim from `ask-user-repo.ts` — zero schema change.
- 30-minute deadline per pending entry → `{ timeout: true }`. Same value as today.
- Bus emission on `resolve()` (`task.state_changed: WORKING`, `message.appended`) moves out of `api/answer.ts` into the bridge so HTTP route and any future resolver path emit identically.

## Migration

| Before | After |
|---|---|
| `adapters/mcp/tools/ask-user.ts` imports `setTaskInputRequired`, `appendToolUseMessage`, `clearTaskPending` from `chat/ask-user-repo` and the `PendingRegistry` from `adapters/mcp/pending-questions` | imports `AskUserBridge` from `chat/ask-user-bridge`; handler body collapses to `bridge.open()` with `bridge.cancel({ reason: 'canceled' })` in the abort path |
| `adapters/mcp/pending-questions.ts` (PendingRegistry interface + factory) | **deleted**; logic inlined as bridge private state |
| `chat/ask-user-repo.ts` (4 exports) | **deleted**; functions become private bridge methods |
| `api/answer.ts` imports `clearTaskPending`, `appendToolResultMessage`, takes `PendingRegistry` dep, emits bus events inline | imports `AskUserBridge`, takes `bridge` dep, calls `bridge.resolve()`, returns mapped HTTP status; no inline bus emission |
| MCP tool factory `makeAskUser(deps)` takes `{ db, pending, ... }` | takes `{ bridge, ... }` |
| HTTP route wiring takes `{ db, pending, bus }` | takes `{ bridge }` |
| Daemon composition root constructs `pending = createPendingRegistry()` and passes to both | constructs `bridge = createAskUserBridge({ db, bus })` and passes the same instance to MCP tool factory + HTTP route |

Wire-format unchanged — plugin sees identical `chat.token` / `chat.tool_use` / `chat.tool_result` envelopes. INPUT_REQUIRED state-transition semantics preserved.

## Error handling

- `resolve()` on unknown `toolUseId` → `{ ok: false; reason: 'unknown' }`. HTTP route maps to 409 `no_matching_pending_question` (same as today — today's route returns 409 for any unknown/not-pending case; the bridge surfaces the two cases separately for clearer logging but the HTTP mapping is preserved).
- `resolve()` when CAS finds Task not in INPUT_REQUIRED (e.g., already resolved, already canceled) → `{ ok: false; reason: 'not_pending' }`. HTTP route maps to 409 `no_matching_pending_question`. Preserves today's atomic-CAS guard.
- `open()` after `cancel()` fires for the same `toolUseId` → `open()` returns `{ canceled: true }`; the pending entry is removed before `cancel()` returns.
- Timeout → `{ timeout: true }`; the `ask_user` tool handler maps this to `ASK_USER_TIMEOUT` exactly as today.
- Double `resolve()` for the same `toolUseId` is idempotent — second call returns `{ ok: false; reason: 'not_pending' }`.

## Testing

**New unit suite:** `daemon/src/chat/ask-user-bridge.test.ts`
- `open → resolve` happy path (returns answer, task back to WORKING, bus events emitted)
- `open → cancel('terminal')` (open() returns `{ canceled: true }`)
- `open → cancel('canceled')` (same Promise resolution, distinct cancel reason recorded if observable)
- `open → timeout` after deadline (returns `{ timeout: true }`; bridge calls `cancel({ reason: 'terminal' })` internally so task transitions back to WORKING and pending entry is removed — matches today's tool-side defer that calls `clearTaskPending` on timeout)
- `resolve(unknown toolUseId)` → `{ ok: false; reason: 'unknown' }`
- `resolve` after `cancel` → `{ ok: false; reason: 'not_pending' }`
- Double `resolve` → second call returns `{ ok: false; reason: 'not_pending' }`, no double bus emission

**Existing E2E:** `ask_user` round-trip spec (plugin → daemon → user answer → resume) must pass unchanged. No new E2E required — bridge is pure refactor of existing behavior.

## Glossary (CONTEXT.md, daemon-internal section)

> **AskUserBridge.** Daemon-internal Module that owns the *Task pauses for user input → resumes on HTTP answer* round-trip. Single dependency for both the `ask_user` MCP tool and the `POST /chat/:id/answer` route. Encapsulates: INPUT_REQUIRED state flip (`setTaskInputRequired`/`clearTaskPending` CAS), tool_use/tool_result message append, in-memory pending registry (`toolUseId → Promise<answer>`, 30-min deadline), bus emission on resolve. Replaces ad-hoc `ask-user-repo.ts` + `pending-questions.ts` coupling.

## Out of scope

- `ask_agent` / `WAITING_ON_AGENT` round-trip — different state, different resolver shape; if later analysis shows the same coupling pattern recurring there, extract an analogous `AgentBridge` then.
- Future MCP tools (`run_skill`, `vault.write`, `spawn_worktree_task`) — none pause a Task on external resolution, so none consume `AskUserBridge`.
- Bus event payload changes — emitted events keep today's shape and field names.
- Schema / SQL changes — CAS bodies copied verbatim.
- Timeout-policy changes (30 min stays).

## References

- [[ADR-0002]] — per-tool MCP registry + factory pattern. `AskUserBridge` is the dep the `makeAskUser` factory closes over.
- CONTEXT.md glossary: `Task (A2A)`, `Chat`, `MCP`, `ask_user`.
- Predecessor pattern: `RunDriver` Module added in VOS-98 (same shape — Interface around a previously scattered concern).
