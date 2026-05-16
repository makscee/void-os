# ADR-0002 — MCP tool registry via `McpServer.registerTool`

- **Status:** Accepted
- **Date:** 2026-05-16
- **Supersedes:** the hand-rolled dispatcher in `daemon/src/adapters/mcp/index.ts:137–206`

## Context

The MCP tool surface in `daemon/src/adapters/mcp/` was assembled tool-by-tool against the low-level `Server` class from `@modelcontextprotocol/sdk`. `buildMcpServer` wires `setRequestHandler(ListToolsRequestSchema, ...)` with a hand-built list and `setRequestHandler(CallToolRequestSchema, ...)` with an `if (name === ...)` ladder. Each ladder branch composes its own per-tool context object, extracts injected ids from `args`, and casts the tool's result to `CallToolResult`.

Three tools exist today (`vault.read`, `ask_user`, `ask_agent`) and the spec at `vault/projects/void-os/CONTEXT.md` commits to at least `run_skill`, `spawn_worktree_task`, and the vault mutation family (`vault.write`, `vault.append`, `vault.delete`). Every one of them will follow the `ask_agent` shape — TaskContext + spawn-side-effect — not the stateless `vault.read` shape. The dispatcher ladder grows linearly with tool count.

Concrete duplication today:

1. **Schema written twice per tool.** `ask_user` defines `ASK_USER_TOOL_DEF.inputSchema` as a JSON Schema literal AND `AskUserInput` as a Zod parser. `ask_agent` does the same. The two can (and probably already do) drift. `vault.read` skipped Zod and validates ad-hoc, which is its own divergence.
2. **Context injection duplicated verbatim.** Both `ask_user` and `ask_agent` branches read `task_id` / `context_id` / `run_id` off `args`, return a `*_MISSING_TASK_ID` error if absent, then build a per-tool `ctx` object. The schema declares these ids as `properties` with `required: ["task_id"]` and relies on the consumer schema being non-strict so the SDK does not reject them. This stuffs runtime metadata into the request body — an MCP layering bug masquerading as convenience.
3. **`_vos_tool_use_id` hint hack** (`ask-user.ts:86–90`) rides on the same non-strict-args behavior to let the fake provider correlate its own synthesized `tool_use` block with the daemon-side pending registry. It is test-shaped metadata living in the user-input slot.
4. **Per-tool dep bags are shaped differently.** `vault.read` takes `{vaultRoot, db}`. `ask_user` takes `{db, bus, pending, ids, deadlineMs, now}`. `ask_agent` takes `{db, bus, ids, loadAgentDefn, dispatchChildTask, now}`. The dispatcher knows the shape of each because it composes them inline.

`@modelcontextprotocol/sdk` (1.20.0, already pinned) ships `McpServer` — a high-level wrapper around `Server` whose `registerTool(name, { description, inputSchema, outputSchema, ... }, cb)` does exactly the work the hand-rolled dispatcher is doing, with one canonical Zod shape per tool. The SDK derives JSON Schema for `tools/list` from the Zod shape, parses+validates input against Zod before invoking the handler, and surfaces request metadata through `RequestHandlerExtra._meta` — the MCP-spec-canonical place for it. The Provider boundary (this ADR) and the Provider event boundary (ADR-0001) follow the same pattern: stop emitting/consuming our own framing where an SDK seam already does the job.

## Decision

The MCP tool surface is registered via `McpServer.registerTool`, one call per tool. The hand-built `CallToolRequestSchema` / `ListToolsRequestSchema` handlers in `index.ts` are deleted. Per-tool deps are bound at registration time via a closure factory.

### Canonical shape per tool

```ts
// daemon/src/adapters/mcp/tools/<tool>.ts
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

export const askUserInput = {
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(80)).max(6).optional(),
} satisfies z.ZodRawShape;

export const askUserOutput = {
  // Free output typing for tools that produce structuredContent.
} satisfies z.ZodRawShape;

export const askUserDef = {
  description: "Pause the current Task and ask the user a question inline in chat. ...",
  inputSchema: askUserInput,
  // outputSchema: askUserOutput,   // when the tool emits structuredContent
};

export interface AskUserDeps { db: Database; bus: EventBus; pending: PendingRegistry; now: () => number; deadlineMs: number; }

export function makeAskUser(deps: AskUserDeps) {
  return async (
    args: z.objectOutputType<typeof askUserInput, z.ZodTypeAny>,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<CallToolResult> => {
    const meta = (extra._meta ?? {}) as Record<string, unknown>;
    const taskId = typeof meta.task_id === "string" ? meta.task_id : undefined;
    if (!taskId) return errResult("ASK_USER_MISSING_TASK_ID");
    // ... existing runAskUser body, deps via closure
  };
}
```

### Registration

```ts
// daemon/src/adapters/mcp/index.ts
export function buildMcpServer(deps: McpDeps): Server {
  const mcp = new McpServer({ name: "void-os", version: pkg.version });
  mcp.registerTool("vault.read", vaultReadDef, makeVaultRead({ vaultRoot, db }));
  mcp.registerTool("ask_user",  askUserDef,    makeAskUser({ db, bus, pending: pendingRegistry, now: Date.now, deadlineMs: ASK_USER_DEADLINE_MS }));
  mcp.registerTool("ask_agent", askAgentDef,   makeAskAgent({ db, bus, loadAgentDefn, dispatchChildTask, now: Date.now }));
  return mcp.server;   // underlying Server, for .connect(transport) in mountMcp
}
```

### Runtime context lives in `_meta`, not args

`task_id`, `context_id`, `run_id`, and any future per-request metadata (e.g. agent identity for tools that need it) are passed through MCP `params._meta` and read by handlers as `extra._meta?.<key>`. The schema for each tool stops declaring these as input properties. The caller — `dispatch-child.ts` for ask_agent child runs, the CC subprocess wrapper for in-Run tool calls — sets them on the MCP request envelope, not in the tool arguments.

The `_vos_tool_use_id` correlation hint in `ask-user.ts` moves to `_meta._vos_tool_use_id`. Same site, semantically honest.

### Why not a custom registry on top of `Server`

A custom `ToolRegistry` Module on top of the low-level `Server` was considered. It would replicate exactly what `McpServer.registerTool` already does: schema-derivation, input validation, typed handler dispatch. Two adapters of the same Interface (ours + theirs) is the worst depth signal in [LANGUAGE.md](../../.claude/skills/improve-codebase-architecture/LANGUAGE.md) — pure pass-through. Adopt the SDK Seam; do not parallel it.

### Why not Zod-derived JSON Schema in our own list handler

A version that kept `Server` + manual `setRequestHandler` and only deduplicated schemas via `zod-to-json-schema` was considered. It removes the JSON Schema literal duplicate but leaves the dispatcher ladder, the per-tool context-injection branch, and the `as unknown as CallToolResult` cast in place — half the friction at the cost of an extra dependency.

## Layout after

```
daemon/src/adapters/mcp/
  index.ts                         # mountMcp + buildMcpServer; N registerTool calls; no dispatcher ladder
  hono-bridge.ts                   # unchanged
  pending-questions.ts             # unchanged
  tools/
    vault-read.ts                  # zod input + makeVaultRead(deps) factory
    ask-user.ts                    # zod input + makeAskUser(deps) factory; reads _meta
    ask-agent.ts                   # zod input + makeAskAgent(deps) factory; reads _meta
```

`McpDeps` shape unchanged. `defaultLoadAgentDefn` + the `dispatchChildTask` placeholder behavior unchanged.

## Migration

Single PR. Surface: `index.ts` shrinks, three tool files swap their `*_TOOL_DEF` exports + `run*` handlers for `*Def` + `make*` factories, callers of the existing `runAskUser` / `runAskAgent` / `handleVaultRead` (tests + dispatch-child wiring) repoint to the factory output.

Order:

1. Add `McpServer` import to `index.ts`, keep `Server` for the `.server` return.
2. Convert `vault-read.ts` first (simplest, no `_meta`).
3. Convert `ask-user.ts`: input schema becomes Zod-only; runtime ids move from `args` to `extra._meta`; `_vos_tool_use_id` hint moves to `_meta._vos_tool_use_id`.
4. Convert `ask-agent.ts`: same pattern. `dispatchChildTask` injection unchanged in shape.
5. Replace the `setRequestHandler` ladder in `index.ts` with three `mcp.registerTool` calls.
6. Update `dispatch-child.ts` (and any test that constructs MCP tool calls) to inject `task_id` / `context_id` / `run_id` via `params._meta` instead of `arguments`. Verify CC subprocess can set `_meta` on tool calls; if not, the per-tool factories accept an args-fallback path and the migration becomes incremental.
7. Update `listMcpTools()` export — either delete (tests can read via `mcp.server.listTools()`) or rebuild from registered tool metadata if any consumer depends on it.
8. Delete the dispatcher ladder, `ASK_USER_MISSING_TASK_ID` / `ASK_AGENT_MISSING_TASK_ID` constants now live inside the handlers.

### Caller-side `_meta` injection — verify before committing

The migration depends on being able to set `params._meta` on outbound MCP tool calls from the CC subprocess. If the CC MCP client does not surface a `_meta` setter, the fallback is to keep `task_id` etc. as Zod-declared input fields on each tool (extras are still typed, just not in the MCP-canonical slot). The dispatcher ladder still goes away in that case; only the metadata layering changes. Confirm via a one-line spike before finalising the tool schemas.

## Consequences

**Positive:**

- **Locality.** Each tool owns its Zod input and output shape, its dep set, and its handler body in one file. The dispatcher Module disappears.
- **Leverage.** Adding `run_skill` / `spawn_worktree_task` / `vault.write` / `vault.append` / `vault.delete` is one `registerTool` call each. Zero edits to a central ladder. Six tools fit the same shape; the boilerplate that would have been duplicated six more times is deleted at the source.
- **Free typing.** Handler input is typed by Zod inference. `outputSchema` carries `structuredContent` typing for tools that emit it (vault.read today, vault.write tomorrow).
- **Honest layering.** Runtime metadata in `_meta` matches MCP spec semantics. Test-shaped hints (`_vos_tool_use_id`) stop living in the user-input slot.
- **Smaller test surface.** Tests construct `makeAskUser(fakeDeps)` and call the returned handler with typed args + a fake `RequestHandlerExtra`. No dispatcher to stub.

**Negative / costs:**

- One coordinated PR touching three tool files + `index.ts` + the caller side that injects `_meta`. Contained.
- Hidden coupling to `@modelcontextprotocol/sdk`'s `McpServer` shape. Already coupled to the SDK; this tightens it.
- `_meta` setter on the CC subprocess MCP client is unverified. Fallback path exists (keep ids in input schema); migration is not blocked on it.

**Reversibility:**

- Reversible by re-introducing a custom `setRequestHandler(CallToolRequestSchema, ...)` ladder around `mcp.server`. The Zod schemas survive a reversal — they are independently useful as input validators. Not anticipated.
