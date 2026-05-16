# AskUserBridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `AskUserBridge` Module as the single owner of the `ask_user` round-trip (Task → INPUT_REQUIRED → HTTP answer → Task → WORKING). Delete `chat/ask-user-repo.ts` and `adapters/mcp/pending-questions.ts`; collapse their responsibilities into the bridge. MCP `ask_user` tool and `POST /chat/:id/answer` route depend only on the bridge Interface.

**Architecture:** New file `daemon/src/chat/ask-user-bridge.ts` exports `AskUserBridge` interface + `createAskUserBridge({ db, bus })` factory. Four private CAS / append SQL ops + in-memory `Map<toolUseId, Awaiter>` registry live inside. Bus emission for state/message events moves out of `ask-user.ts` (open path) and `api/answer.ts` (resolve path) into the bridge so both paths emit identically. Wire-format unchanged; SQL bodies copied verbatim.

**Tech Stack:** TypeScript, Bun, `bun:test`, `bun:sqlite`, Hono. Existing patterns: factory deps + Zod input shapes per MCP tool ([[ADR-0002]]).

**Spec:** `docs/superpowers/specs/2026-05-16-ask-user-bridge-design.md`

---

## File Map

**Create:**
- `daemon/src/chat/ask-user-bridge.ts` — new Module (Interface, factory, private CAS ops, private pending registry)
- `daemon/src/chat/ask-user-bridge.test.ts` — bun:test unit suite

**Modify:**
- `daemon/src/app.ts` — construct `bridge = createAskUserBridge({ db, bus })` once; pass to `mountMcp` and `mountAnswerRoute` instead of `pendingRegistry`
- `daemon/src/adapters/mcp/index.ts` — drop module-scope `pendingRegistry` singleton + export; thread `bridge` from `mountMcp` into `makeAskUser` factory deps
- `daemon/src/adapters/mcp/tools/ask-user.ts` — replace `setTaskInputRequired` / `appendToolUseMessage` / `clearTaskPending` calls + manual bus emission with single `bridge.open()` call; map result to `CallToolResult`
- `daemon/src/api/answer.ts` — replace `clearTaskPending` / `appendToolResultMessage` / bus emission / `pending.resolve` sequence with single `bridge.resolve()` call; map result to HTTP status
- `vault/projects/void-os/CONTEXT.md` — add `AskUserBridge` glossary entry under daemon-internal section

**Delete (final task):**
- `daemon/src/chat/ask-user-repo.ts`
- `daemon/src/adapters/mcp/pending-questions.ts`

**Test (existing, must pass unchanged):**
- `daemon/src/providers/fake/__tests__/ask-user.test.ts` (E2E round-trip)
- any other suite that imports the deleted files (Task 7 greps)

---

## Task 1: AskUserBridge — Interface + happy-path test (TDD)

**Files:**
- Test: `daemon/src/chat/ask-user-bridge.test.ts` (create)
- Create: `daemon/src/chat/ask-user-bridge.ts`

- [ ] **Step 1: Write the first failing test (happy path: open → resolve)**

Create `daemon/src/chat/ask-user-bridge.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus } from "../events/index.ts";
import { createAskUserBridge, type AskUserBridge } from "./ask-user-bridge.ts";

const MIGRATIONS = join(import.meta.dir, "../adapters/sqlite/migrations");

function migrate(db: Database) {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
}

function seedContextAndTask(db: Database) {
  const contextId = "ctx-1";
  const taskId = "task-1";
  db.exec(`INSERT INTO contexts (id, agent_id, created_at) VALUES ('${contextId}', 'agent-1', 1)`);
  db.exec(`INSERT INTO agents (id, name, created_at) VALUES ('agent-1', 'a', 1)`);
  db.exec(
    `INSERT INTO tasks (id, context_id, state, created_at, updated_at) VALUES ('${taskId}', '${contextId}', 'TASK_STATE_WORKING', 1, 1)`,
  );
  return { contextId, taskId };
}

describe("AskUserBridge", () => {
  let db: Database;
  let bus: ReturnType<typeof createEventBus>;
  let bridge: AskUserBridge;
  let emitted: Array<{ type: string; payload: unknown }>;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    bus = createEventBus({ db });
    emitted = [];
    bus.subscribe("task.state_changed", (e) => emitted.push({ type: e.type, payload: e.payload }));
    bus.subscribe("message.appended", (e) => emitted.push({ type: e.type, payload: e.payload }));
    bridge = createAskUserBridge({ db, bus });
  });

  it("open → resolve: returns answer, task back to WORKING, bus events emitted", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-1";

    const opened = bridge.open({
      taskId, contextId, runId: null, toolUseId,
      question: "yes or no?", options: ["yes", "no"],
    });

    // Task flipped on open
    const afterOpen = db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
    expect(afterOpen.state).toBe("TASK_STATE_INPUT_REQUIRED");

    // Resolve from HTTP side
    const res = await bridge.resolve({ taskId, toolUseId, answer: "yes" });
    expect(res).toEqual({ ok: true });

    const settled = await opened;
    expect(settled).toEqual({ answer: "yes" });

    const afterResolve = db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
    expect(afterResolve.state).toBe("TASK_STATE_WORKING");

    // Bus: state INPUT_REQUIRED, message.appended (tool_use), state WORKING, message.appended (tool_result)
    const types = emitted.map((e) => `${e.type}`);
    expect(types).toContain("task.state_changed");
    expect(types).toContain("message.appended");
    expect(types.filter((t) => t === "task.state_changed").length).toBe(2);
    expect(types.filter((t) => t === "message.appended").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os/daemon && bun test src/chat/ask-user-bridge.test.ts`
Expected: FAIL — `Cannot find module './ask-user-bridge.ts'`

- [ ] **Step 3: Write minimal bridge to make happy-path pass**

Create `daemon/src/chat/ask-user-bridge.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { EventBus } from "../events/index.ts";
import { makeMessagesRepo } from "./messages-repo.ts";

export interface OpenArgs {
  taskId: string;
  contextId: string;
  runId: string | null;
  toolUseId: string;
  question: string;
  options?: string[];
}

export type OpenResult =
  | { answer: string }
  | { canceled: true }
  | { timeout: true };

export interface ResolveArgs {
  taskId: string;
  toolUseId: string;
  answer: string;
}

export type ResolveResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "not_pending" };

export interface CancelArgs {
  taskId: string;
  toolUseId: string;
  reason: "terminal" | "canceled";
}

export interface AskUserBridge {
  open(args: OpenArgs): Promise<OpenResult>;
  resolve(args: ResolveArgs): Promise<ResolveResult>;
  cancel(args: CancelArgs): Promise<void>;
  size(): number;
}

interface Awaiter {
  resolve: (r: OpenResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CreateAskUserBridgeDeps {
  db: Database;
  bus: EventBus;
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 30 * 60 * 1000; // 30 min — matches today's makeAskUser deadline

export function createAskUserBridge(deps: CreateAskUserBridgeDeps): AskUserBridge {
  const { db, bus } = deps;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pending = new Map<string, Awaiter>();
  const messages = makeMessagesRepo(db);

  // --- Private CAS + append ops (copied verbatim from ask-user-repo.ts) ---

  function setTaskInputRequired(
    taskId: string, toolUseId: string, question: string, options: string[] | undefined,
  ): boolean {
    const stash = JSON.stringify({ tool_use_id: toolUseId, question, options: options ?? null });
    const info = db
      .query(
        `UPDATE tasks SET state = 'TASK_STATE_INPUT_REQUIRED', pending = ?, updated_at = strftime('%s','now')
         WHERE id = ? AND state = 'TASK_STATE_WORKING'`,
      )
      .run(stash, taskId);
    return info.changes > 0;
  }

  function clearTaskPending(taskId: string, toolUseId: string): boolean {
    const info = db
      .query(
        `UPDATE tasks SET state = 'TASK_STATE_WORKING', pending = NULL, updated_at = strftime('%s','now')
         WHERE id = ? AND state = 'TASK_STATE_INPUT_REQUIRED'
           AND json_extract(pending, '$.tool_use_id') = ?`,
      )
      .run(taskId, toolUseId);
    return info.changes > 0;
  }

  function appendToolUseMessage(a: OpenArgs): number {
    return messages.appendMessage({
      taskId: a.taskId,
      contextId: a.contextId,
      runId: a.runId,
      role: "tool",
      parts: [
        {
          kind: "data",
          data: { kind: "tool_use", tool_use_id: a.toolUseId, name: "ask_user", input: { question: a.question, options: a.options ?? null } },
        },
      ],
    });
  }

  function appendToolResultMessage(taskId: string, contextId: string, runId: string | null, toolUseId: string, answer: string): number {
    return messages.appendMessage({
      taskId, contextId, runId,
      role: "tool",
      parts: [
        { kind: "data", data: { kind: "tool_result", tool_use_id: toolUseId, output: answer, is_error: false } },
      ],
    });
  }

  // --- Public Interface ---

  function open(args: OpenArgs): Promise<OpenResult> {
    return new Promise<OpenResult>((resolveFn) => {
      const tx = db.transaction(() => {
        if (!setTaskInputRequired(args.taskId, args.toolUseId, args.question, args.options)) {
          throw new Error("TASK_NOT_WORKING");
        }
        appendToolUseMessage(args);
      });
      try {
        tx();
      } catch (err) {
        // CAS lost / task not in WORKING — surface as immediate canceled
        resolveFn({ canceled: true });
        return;
      }

      bus.emit({
        type: "task.state_changed",
        chatId: args.contextId,
        payload: { taskId: args.taskId, state: "TASK_STATE_INPUT_REQUIRED" },
      });
      bus.emit({
        type: "message.appended",
        chatId: args.contextId,
        payload: { taskId: args.taskId },
      });

      const timer = setTimeout(() => {
        const a = pending.get(args.toolUseId);
        if (!a) return;
        pending.delete(args.toolUseId);
        // Timeout = revert task to WORKING + emit state event
        const cleared = clearTaskPending(args.taskId, args.toolUseId);
        if (cleared) {
          bus.emit({
            type: "task.state_changed",
            chatId: args.contextId,
            payload: { taskId: args.taskId, state: "TASK_STATE_WORKING" },
          });
        }
        a.resolve({ timeout: true });
      }, deadlineMs);

      pending.set(args.toolUseId, { resolve: resolveFn, timer });
    });
  }

  async function resolveAction(args: ResolveArgs): Promise<ResolveResult> {
    const a = pending.get(args.toolUseId);
    if (!a) return { ok: false, reason: "unknown" };

    // Load contextId + runId for message append + bus emission
    const ctxRow = db
      .query("SELECT context_id FROM tasks WHERE id = ?")
      .get(args.taskId) as { context_id: string } | null;
    if (!ctxRow) return { ok: false, reason: "unknown" };
    const contextId = ctxRow.context_id;
    const runRow = db
      .query("SELECT id FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
      .get(args.taskId) as { id: string } | null;
    const runId = runRow?.id ?? null;

    try {
      const tx = db.transaction(() => {
        if (!clearTaskPending(args.taskId, args.toolUseId)) throw new Error("PENDING_MISMATCH");
        appendToolResultMessage(args.taskId, contextId, runId, args.toolUseId, args.answer);
      });
      tx();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "PENDING_MISMATCH") return { ok: false, reason: "not_pending" };
      throw err;
    }

    // Clear timer + remove pending + resolve awaiter
    if (a.timer) clearTimeout(a.timer);
    pending.delete(args.toolUseId);
    a.resolve({ answer: args.answer });

    bus.emit({
      type: "task.state_changed",
      chatId: contextId,
      payload: { taskId: args.taskId, state: "TASK_STATE_WORKING" },
    });
    bus.emit({
      type: "message.appended",
      chatId: contextId,
      payload: { taskId: args.taskId },
    });

    return { ok: true };
  }

  async function cancel(args: CancelArgs): Promise<void> {
    const a = pending.get(args.toolUseId);
    if (!a) return;
    if (a.timer) clearTimeout(a.timer);
    pending.delete(args.toolUseId);
    const cleared = clearTaskPending(args.taskId, args.toolUseId);
    if (cleared) {
      const ctxRow = db
        .query("SELECT context_id FROM tasks WHERE id = ?")
        .get(args.taskId) as { context_id: string } | null;
      if (ctxRow) {
        bus.emit({
          type: "task.state_changed",
          chatId: ctxRow.context_id,
          payload: { taskId: args.taskId, state: "TASK_STATE_WORKING" },
        });
      }
    }
    a.resolve({ canceled: true });
  }

  return { open, resolve: resolveAction, cancel, size: () => pending.size };
}
```

- [ ] **Step 4: Run test to verify happy path passes**

Run: `cd workspace/void-os/daemon && bun test src/chat/ask-user-bridge.test.ts`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git -C workspace/void-os add daemon/src/chat/ask-user-bridge.ts daemon/src/chat/ask-user-bridge.test.ts
git -C workspace/void-os commit -m "feat(VOS-100): AskUserBridge module + happy-path test"
```

---

## Task 2: Bridge — cancel, timeout, error-path tests

**Files:**
- Modify: `daemon/src/chat/ask-user-bridge.test.ts`
- Modify (if test surfaces a bug): `daemon/src/chat/ask-user-bridge.ts`

- [ ] **Step 1: Append cancel + edge-case tests to the test file**

Add inside the `describe("AskUserBridge", ...)` block:

```typescript
  it("open → cancel('terminal'): open() resolves { canceled: true }, task back to WORKING", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-c1";
    const opened = bridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });

    await bridge.cancel({ taskId, toolUseId, reason: "terminal" });

    const settled = await opened;
    expect(settled).toEqual({ canceled: true });

    const row = db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
    expect(row.state).toBe("TASK_STATE_WORKING");
  });

  it("open → cancel('canceled'): same shape, user-canceled path", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-c2";
    const opened = bridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });

    await bridge.cancel({ taskId, toolUseId, reason: "canceled" });

    const settled = await opened;
    expect(settled).toEqual({ canceled: true });
  });

  it("open → timeout: deadline fires, open() resolves { timeout: true }, task back to WORKING", async () => {
    const fastBridge = createAskUserBridge({ db, bus, deadlineMs: 10 });
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-t1";
    const opened = fastBridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });

    const settled = await opened;
    expect(settled).toEqual({ timeout: true });

    const row = db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
    expect(row.state).toBe("TASK_STATE_WORKING");
  });

  it("resolve(unknown toolUseId) → { ok: false, reason: 'unknown' }", async () => {
    const { taskId } = seedContextAndTask(db);
    const res = await bridge.resolve({ taskId, toolUseId: "never-opened", answer: "x" });
    expect(res).toEqual({ ok: false, reason: "unknown" });
  });

  it("resolve after cancel → { ok: false, reason: 'unknown' } (pending entry already gone)", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-rac";
    const opened = bridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });
    await bridge.cancel({ taskId, toolUseId, reason: "canceled" });
    await opened;
    const res = await bridge.resolve({ taskId, toolUseId, answer: "x" });
    expect(res).toEqual({ ok: false, reason: "unknown" });
  });

  it("double resolve: second call → { ok: false, reason: 'unknown' }, no double bus emission", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-dr";
    const opened = bridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });
    const r1 = await bridge.resolve({ taskId, toolUseId, answer: "first" });
    expect(r1).toEqual({ ok: true });
    await opened;
    const before = emitted.length;
    const r2 = await bridge.resolve({ taskId, toolUseId, answer: "second" });
    expect(r2).toEqual({ ok: false, reason: "unknown" });
    expect(emitted.length).toBe(before);
  });
```

- [ ] **Step 2: Run tests; fix bridge if any fail**

Run: `cd workspace/void-os/daemon && bun test src/chat/ask-user-bridge.test.ts`
Expected: 7 passed. If a test fails, fix `ask-user-bridge.ts` (do NOT relax the test).

- [ ] **Step 3: Commit**

```bash
git -C workspace/void-os add daemon/src/chat/ask-user-bridge.test.ts daemon/src/chat/ask-user-bridge.ts
git -C workspace/void-os commit -m "test(VOS-100): bridge cancel/timeout/error paths"
```

---

## Task 3: Wire bridge into composition root

**Files:**
- Modify: `daemon/src/app.ts`
- Modify: `daemon/src/adapters/mcp/index.ts`
- Modify: `daemon/src/api/answer.ts` (signature only — full handler swap in Task 5)
- Modify: `daemon/src/adapters/mcp/tools/ask-user.ts` (signature only — full handler swap in Task 4)

- [ ] **Step 1: Add `bridge` to `mountMcp` deps; thread through to `makeAskUser`**

In `daemon/src/adapters/mcp/index.ts`:
- Remove the module-scope `export const pendingRegistry = createPendingRegistry();` line (and the import).
- Add `bridge: AskUserBridge` to `MountMcpDeps`.
- In `mountMcp`, replace the `makeAskUser` factory call: pass `bridge` instead of `pending: pendingRegistry` (and drop `db`, `bus`, `now`, `deadlineMs` deps that the bridge now owns).

- [ ] **Step 2: Change `mountAnswerRoute` deps signature**

In `daemon/src/api/answer.ts`:
- Replace `pending: PendingRegistry` field in `AnswerDeps` with `bridge: AskUserBridge`.
- Leave the handler body unchanged for now — Task 5 swaps it.

- [ ] **Step 3: Change `makeAskUser` deps signature**

In `daemon/src/adapters/mcp/tools/ask-user.ts`:
- Replace `AskUserDeps` with `{ bridge: AskUserBridge }`.
- Leave the handler body unchanged for now — Task 4 swaps it.

- [ ] **Step 4: Construct bridge in app.ts and pass it**

In `daemon/src/app.ts`, after `const bus = createEventBus({ db: deps.db });`:

```typescript
  const bridge = createAskUserBridge({ db: deps.db, bus });
```

Replace the `mountMcp(app, { ... pending: pendingRegistry, ... })` call (if present) with `bridge`. Replace `mountAnswerRoute(app, { db: deps.db, bus, pending: pendingRegistry, emit })` with `mountAnswerRoute(app, { db: deps.db, bus, bridge, emit })`.

Add import: `import { createAskUserBridge } from "./chat/ask-user-bridge.ts";`
Drop import: `pendingRegistry` from `./adapters/mcp/index.ts` (if it was imported here).

- [ ] **Step 5: Type-check only — handlers still call the old functions; this step just confirms wiring compiles. Build, expect errors only inside the two handlers still pending swap.**

Run: `cd workspace/void-os/daemon && bun tsc --noEmit 2>&1 | head -40`
Expected: errors confined to `tools/ask-user.ts` and `api/answer.ts` handler bodies (they still reference `deps.pending`, `deps.db`, etc.). No errors elsewhere.

If errors appear outside those two files, fix them before continuing.

- [ ] **Step 6: Commit**

```bash
git -C workspace/void-os add daemon/src/app.ts daemon/src/adapters/mcp/index.ts daemon/src/adapters/mcp/tools/ask-user.ts daemon/src/api/answer.ts
git -C workspace/void-os commit -m "feat(VOS-100): wire AskUserBridge into composition root"
```

---

## Task 4: Migrate `ask-user.ts` MCP tool handler

**Files:**
- Modify: `daemon/src/adapters/mcp/tools/ask-user.ts`

- [ ] **Step 1: Replace handler body with `bridge.open()` call**

Open `daemon/src/adapters/mcp/tools/ask-user.ts`. Replace the entire `makeAskUser` factory body (the section that calls `setTaskInputRequired`, `appendToolUseMessage`, `bus.emit`, `pending.register`, and the `catch` that calls `clearTaskPending`) with:

```typescript
export interface AskUserDeps {
  bridge: AskUserBridge;
}

export function makeAskUser(deps: AskUserDeps) {
  return async (
    args: z.objectOutputType<typeof askUserInput, z.ZodTypeAny>,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<CallToolResult> => {
    const meta = (extra.requestInfo?.meta ?? {}) as Record<string, unknown>;
    const taskId = String(meta._vos_task_id ?? "");
    const contextId = String(meta._vos_context_id ?? "");
    const runId = typeof meta._vos_run_id === "string" ? meta._vos_run_id : null;
    if (!taskId || !contextId) {
      return { content: [{ type: "text", text: "MISSING_TASK_META" }], isError: true };
    }
    const toolUseId = typeof meta._vos_tool_use_id === "string" && meta._vos_tool_use_id.length > 0
      ? meta._vos_tool_use_id
      : randomUUID();

    const result = await deps.bridge.open({
      taskId, contextId, runId, toolUseId,
      question: args.question,
      options: args.options,
    });

    if ("answer" in result) return { content: [{ type: "text", text: result.answer }] };
    if ("timeout" in result) return { content: [{ type: "text", text: "ASK_USER_TIMEOUT" }], isError: true };
    return { content: [{ type: "text", text: "ASK_USER_CANCELLED" }], isError: true };
  };
}
```

Add/remove imports as needed:
- Add: `import type { AskUserBridge } from "../../../chat/ask-user-bridge.ts";`
- Remove: imports of `setTaskInputRequired`, `appendToolUseMessage`, `clearTaskPending` from `../../../chat/ask-user-repo.ts`
- Remove: imports of `PendingRegistry` and `EventBus` (no longer needed in this file)
- Remove: `Database` import if unused after the swap

- [ ] **Step 2: Type-check**

Run: `cd workspace/void-os/daemon && bun tsc --noEmit 2>&1 | head -20`
Expected: zero errors in `ask-user.ts`. Errors may remain only in `api/answer.ts` (handled next task).

- [ ] **Step 3: Run unit tests + ask-user E2E**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/tools/ src/providers/fake/__tests__/ask-user.test.ts`
Expected: PASS. The E2E test exercises the full plugin ↔ daemon round-trip; passing here proves wire-format + behavior preserved.

If the E2E fails: do NOT modify the test. Read the failure carefully — the bridge or this handler swap is wrong.

- [ ] **Step 4: Commit**

```bash
git -C workspace/void-os add daemon/src/adapters/mcp/tools/ask-user.ts
git -C workspace/void-os commit -m "refactor(VOS-100): ask_user MCP tool depends on bridge only"
```

---

## Task 5: Migrate `api/answer.ts` route handler

**Files:**
- Modify: `daemon/src/api/answer.ts`

- [ ] **Step 1: Replace handler body with `bridge.resolve()` call**

Open `daemon/src/api/answer.ts`. Replace the `mountAnswerRoute` body that does the transaction + bus emission + `pending.resolve` with:

```typescript
export interface AnswerDeps {
  db: Database;
  bridge: AskUserBridge;
  emit?: (event: string, payload: Record<string, unknown>) => void;
}

export function mountAnswerRoute(app: Hono, deps: AnswerDeps): void {
  app.post("/chat/:chat_id/answer", async (c) => {
    let body: z.infer<typeof AnswerBody>;
    try {
      body = AnswerBody.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }

    const chatId = c.req.param("chat_id");
    const ctxRow = deps.db
      .query("SELECT id FROM contexts WHERE id = ?")
      .get(chatId) as { id: string } | null;
    if (!ctxRow) return c.json({ error: "chat_not_found" }, 404);

    let taskId: string;
    try {
      taskId = openTaskFor(deps.db, chatId);
    } catch {
      return c.json({ error: "no_matching_pending_question" }, 409);
    }

    // Resolve via bridge — handles CAS, message append, state event, message event, and awaiter resolution
    const res = await deps.bridge.resolve({ taskId, toolUseId: body.tool_use_id, answer: body.answer });
    if (!res.ok) {
      if (res.reason === "unknown") return c.json({ error: "no_matching_pending_question" }, 409);
      return c.json({ error: "no_matching_pending_question" }, 409);
    }

    // WS broadcast (kept here — outside bridge scope)
    const runRow = deps.db
      .query("SELECT id FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
      .get(taskId) as { id: string } | null;
    deps.emit?.("chat.tool_result", {
      chat_id: chatId,
      run_id: runRow?.id ?? null,
      tool_call_id: body.tool_use_id,
      output: body.answer,
      is_error: false,
    });

    return c.json({ ok: true });
  });
}
```

Add: `import type { AskUserBridge } from "../chat/ask-user-bridge.ts";`
Remove imports: `clearTaskPending`, `appendToolResultMessage` from `../chat/ask-user-repo.ts`; `PendingRegistry` from `../adapters/mcp/pending-questions.ts`; `EventBus` from `../events/index.ts` (no longer used in this file).

- [ ] **Step 2: Type-check**

Run: `cd workspace/void-os/daemon && bun tsc --noEmit 2>&1 | head -20`
Expected: zero errors.

- [ ] **Step 3: Run answer + E2E tests**

Run: `cd workspace/void-os/daemon && bun test src/api/ src/providers/fake/__tests__/ask-user.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C workspace/void-os add daemon/src/api/answer.ts
git -C workspace/void-os commit -m "refactor(VOS-100): /answer route depends on bridge only"
```

---

## Task 6: Delete dead files + sweep stragglers

**Files:**
- Delete: `daemon/src/chat/ask-user-repo.ts`
- Delete: `daemon/src/adapters/mcp/pending-questions.ts`
- Possibly modify: any straggler that still imports either

- [ ] **Step 1: Grep for remaining imports**

Run:
```bash
grep -rn "ask-user-repo" workspace/void-os/daemon/src/ || echo "clean: ask-user-repo"
grep -rn "pending-questions" workspace/void-os/daemon/src/ || echo "clean: pending-questions"
grep -rn "pendingRegistry" workspace/void-os/daemon/src/ || echo "clean: pendingRegistry"
```

Expected: each prints "clean: ...".

If any non-test/non-dead-file import remains, fix it in this task. Common stragglers:
- `cancelAll()` was used by graceful-shutdown — if so, replace with calling `bridge.cancel()` for each pending entry, OR drop the feature if no longer needed (decide based on actual caller; document choice in commit msg).
- Other test files (`*-repo.test.ts` for ask-user-repo) — delete alongside the source they test.

- [ ] **Step 2: Delete the two files**

```bash
git -C workspace/void-os rm daemon/src/chat/ask-user-repo.ts
git -C workspace/void-os rm daemon/src/adapters/mcp/pending-questions.ts
# Also delete companion tests if they exist:
git -C workspace/void-os rm daemon/src/chat/ask-user-repo.test.ts 2>/dev/null || true
git -C workspace/void-os rm daemon/src/adapters/mcp/pending-questions.test.ts 2>/dev/null || true
```

- [ ] **Step 3: Full type-check + full test suite**

Run: `cd workspace/void-os/daemon && bun tsc --noEmit && bun test`
Expected: zero TS errors. All tests green.

If a test imports a deleted file: that test was exercising internals that the bridge now owns — either delete the test (covered by `ask-user-bridge.test.ts`) or migrate the assertion to target the bridge. Decide per-test.

- [ ] **Step 4: Commit**

```bash
git -C workspace/void-os add -A
git -C workspace/void-os commit -m "chore(VOS-100): delete ask-user-repo + pending-questions"
```

---

## Task 7: Update CONTEXT.md glossary

**Files:**
- Modify: `vault/projects/void-os/CONTEXT.md` (path is in the hub repo: `/Users/admin/hub-wt/VOS-100/vault/projects/void-os/CONTEXT.md`)

Note: this file lives in the **hub** state plane, not the void-os repo. Per `/work` rules, this edit must go through `tools/state-write/sw` to commit to canonical hub master. The orchestrator runs this — not a subagent.

- [ ] **Step 1: Find the daemon-internal glossary section**

Run: `grep -n "daemon-internal\|## Glossary\|RunDriver" /Users/admin/hub-wt/VOS-100/vault/projects/void-os/CONTEXT.md | head -10`

Locate the daemon-internal glossary subsection where `RunDriver` was added in VOS-98.

- [ ] **Step 2: Insert AskUserBridge entry alphabetically**

Add entry under the daemon-internal glossary, alphabetically placed (likely after a previous `A*` entry or as the first):

```markdown
**AskUserBridge.** Daemon-internal Module that owns the *Task pauses for user input → resumes on HTTP answer* round-trip. Single dependency for both the `ask_user` MCP tool and the `POST /chat/:id/answer` route. Encapsulates: INPUT_REQUIRED state flip (`setTaskInputRequired`/`clearTaskPending` CAS), tool_use/tool_result message append, in-memory pending registry (`toolUseId → Promise<answer>`, 30-min deadline), bus emission on resolve. Replaces ask-user-repo.ts + pending-questions.ts coupling.
```

- [ ] **Step 3: Commit via sw**

Run from anywhere:
```bash
/Users/admin/hub/tools/state-write/sw "docs(VOS-100): CONTEXT.md glossary — AskUserBridge" -- bash -c '
  set -e
  cd /Users/admin/hub
  git add vault/projects/void-os/CONTEXT.md
'
```

Note: the edit happens in the worktree, but `sw` operates on canonical hub master. If the worktree edit is the source: copy the file via `cp /Users/admin/hub-wt/VOS-100/vault/projects/void-os/CONTEXT.md /Users/admin/hub/vault/projects/void-os/CONTEXT.md` BEFORE running `sw`. Alternatively, edit canonical hub copy directly with the Edit tool, then run `sw` to commit.

Expected sw output: a single line with commit SHA + lock-wait-ms.

---

## Task 8: Final gate — full test suite + acceptance check

**Files:**
- None (verification only)

- [ ] **Step 1: Run full daemon test suite**

Run: `cd workspace/void-os/daemon && bun test`
Expected: all tests green. If anything red, fix before claiming done.

- [ ] **Step 2: Walk the task's Acceptance bullets**

Open `/Users/admin/hub/vault/work/tasks/active/VOS-100-*.md`. For each Acceptance bullet, confirm:
- [x] `daemon/src/chat/ask-user-bridge.ts` exists and owns INPUT_REQUIRED lifecycle
- [x] `adapters/mcp/tools/ask-user.ts` no longer imports from `chat/ask-user-repo.ts`
- [ ] ~~`ask-agent.ts` migrated~~ — **delete this bullet** (out of scope per design)
- [x] `adapters/mcp/pending-questions.ts` collapsed
- [x] `api/answer.ts` resolves through bridge
- [x] Wire-format unchanged — proven by E2E pass
- [x] CONTEXT.md glossary updated
- [x] Bridge unit tests cover all 6 scenarios; E2E passes
- [ ] Code review evidence — Task 9

If the acceptance bullet about `ask-agent.ts` is still present in the task file, remove it via `sw_run` with a short commit message.

- [ ] **Step 3: Update task file via sw (delete out-of-scope acceptance bullet if still present)**

If needed:
```bash
/Users/admin/hub/tools/state-write/sw "task(VOS-100): drop ask-agent from Acceptance (out of scope)" -- bash -c '
  set -e
  cd /Users/admin/hub
  f=$(ls vault/work/tasks/active/VOS-100-*.md | head -1)
  # Manually edit the bullet out, or use sed:
  # (skip if not present)
  git add "$f"
'
```

---

## Task 9: Code review gate (mandatory before `/done`)

**Files:**
- None (review only)

- [ ] **Step 1: Dispatch code review subagent**

Invoke `superpowers:requesting-code-review` on the full `task/VOS-100` branch in `/Users/admin/hub-wt/VOS-100/workspace/void-os`. Scope: every commit between `task/VOS-100` and `main`.

- [ ] **Step 2: Address review feedback**

If review surfaces issues: dispatch fresh subagents to fix, commit on the same task branch. Re-run review if material changes.

- [ ] **Step 3: Log review evidence in task Work Log via sw**

```bash
/Users/admin/hub/tools/state-write/sw "task(VOS-100): work-log code review pass" -- bash -c '
  set -e
  cd /Users/admin/hub
  f=$(ls vault/work/tasks/active/VOS-100-*.md | head -1)
  cat >> "$f" <<EOF

### $(date -u +%Y-%m-%d) · code review
- reviewer: superpowers:requesting-code-review subagent
- branch: task/VOS-100 in workspace/void-os
- result: <pass | passed with fixes (sha …)>
- notes: <anything non-obvious>
EOF
  git add "$f"
'
```

- [ ] **Step 4: Prompt user to run `/done VOS-100`**

State to user: "All acceptance met. Code review logged. Run /done VOS-100 to merge task branch + close."
