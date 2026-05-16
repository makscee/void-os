# VOS-95: collapse ask_agent MCP tool into single module

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold 6 sibling modules of `ask_agent` MCP tool into a single ~300-line `ask-agent.ts`. Delete sibling src + sibling tests. Add 3 new handler-level tests covering branches previously only exercised through deleted unit tests.

**Architecture:** `daemon/src/adapters/mcp/tools/ask-agent.ts` becomes self-contained: tool def, error type, depth probe + constant, mint+flip tx, wait helper, terminal translator, handler. `daemon/src/adapters/mcp/index.ts` imports `ASK_AGENT_TOOL_DEF` from the same module (was `./tools/ask-agent-def`). Six sibling .ts files and six sibling .test.ts files are deleted.

**Tech Stack:** TypeScript, Bun, bun:sqlite, bun:test.

**Worktree:** `/Users/admin/void-os-wt/VOS-95` on branch `task/VOS-95`. All paths below are relative to that worktree root.

---

### Task 1: Three TDD handler-level tests

**Files:**
- Modify: `daemon/test/adapters/mcp/tools/ask-agent.test.ts` (append three new tests inside the existing `describe("runAskAgent (composition)", ...)` block, before the closing `})`).

The existing test file already wires `runMigrationsFromDir` + `seed()` + `buildCtx()` helpers — reuse them.

- [ ] **Step 1: Append test "non-AskAgentError wrapping: loadAgentDefn plain Error → internal: prefix"**

Insert this test block immediately after the existing `"depth limit exceeded"` test, before `"Finding 4: ..."`:

```typescript
  test("non-AskAgentError wrapping: loadAgentDefn plain Error → internal: prefix", async () => {
    const { contextId, parentId } = seed(db);
    const bus = createEventBus();
    const ctx: AskAgentCtx = {
      db,
      bus,
      taskId: parentId,
      contextId,
      loadAgentDefn: () => {
        throw new Error("boom-defn");
      },
      dispatchChildTask: async () => {},
      now: () => Math.floor(Date.now() / 1000),
    };

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/^internal: boom-defn/) }],
    });
    // Parent unchanged, no child minted.
    const parent = db.query("SELECT state FROM tasks WHERE id=?").get(parentId) as
      | { state: string }
      | undefined;
    expect(parent?.state).toBe("TASK_STATE_WORKING");
    const kids = db
      .query("SELECT count(*) as n FROM tasks WHERE parent_task_id=?")
      .get(parentId) as { n: number } | undefined;
    expect(kids?.n).toBe(0);
  });
```

- [ ] **Step 2: Append test "mint rollback: parent not in WORKING → tool-error + no orphan child row"**

```typescript
  test("mint rollback: parent not in WORKING leaves no orphan child", async () => {
    const { contextId, parentId } = seed(db);
    // Flip parent out of WORKING before the call so mint's CAS-update fails.
    db.run(
      `UPDATE tasks SET state='TASK_STATE_SUBMITTED' WHERE id=?`,
      [parentId],
    );
    const caller: AgentDefn = { name: "maya" };
    const ctx = buildCtx(db, contextId, parentId, caller);

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/parent task not in WORKING/i) }],
    });
    const kids = db
      .query("SELECT count(*) as n FROM tasks WHERE parent_task_id=?")
      .get(parentId) as { n: number } | undefined;
    expect(kids?.n).toBe(0);
  });
```

- [ ] **Step 3: Append test "FAILED metadata fallback: errorMessage surfaces; malformed metadata → unknown"**

```typescript
  test("FAILED metadata fallback: errorMessage surfaces; malformed → 'unknown'", async () => {
    // Sub-case A: well-formed metadata.errorMessage="boom".
    {
      const { contextId, parentId } = seed(db);
      const caller: AgentDefn = { name: "maya" };
      const ctx = buildCtx(db, contextId, parentId, caller, async (childTaskId) => {
        const now = Math.floor(Date.now() / 1000);
        db.run(
          `UPDATE tasks
             SET state='TASK_STATE_FAILED',
                 metadata=?,
                 updated_at=?
           WHERE id=?`,
          [JSON.stringify({ errorMessage: "boom" }), now, childTaskId],
        );
        ctx.bus.emit({
          type: "task.state_changed",
          chatId: contextId,
          payload: { taskId: childTaskId, state: "TASK_STATE_FAILED" },
        });
      });
      const result = await runAskAgent(ctx, {
        target_agent_id: "journaler",
        message: "hi",
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(
        (result as { content: Array<{ text: string }> }).content[0]!.text,
      ).toMatch(/boom/);
    }

    // Sub-case B: malformed metadata → "unknown".
    {
      // Fresh DB to avoid colliding with sub-case A's seeded ids.
      db = new Database(":memory:");
      runMigrationsFromDir(db, MIGRATIONS);
      const { contextId, parentId } = seed(db);
      const caller: AgentDefn = { name: "maya" };
      const ctx = buildCtx(db, contextId, parentId, caller, async (childTaskId) => {
        const now = Math.floor(Date.now() / 1000);
        db.run(
          `UPDATE tasks
             SET state='TASK_STATE_FAILED',
                 metadata='not-json',
                 updated_at=?
           WHERE id=?`,
          [now, childTaskId],
        );
        ctx.bus.emit({
          type: "task.state_changed",
          chatId: contextId,
          payload: { taskId: childTaskId, state: "TASK_STATE_FAILED" },
        });
      });
      const result = await runAskAgent(ctx, {
        target_agent_id: "journaler",
        message: "hi",
      });
      expect(
        (result as { content: Array<{ text: string }> }).content[0]!.text,
      ).toMatch(/unknown/);
    }
  });
```

Note: sub-case B reassigns `db`. The shared `beforeEach` reinitialises `db` for the next test, so this does not leak.

- [ ] **Step 4: Add the missing imports at the top of the test file if not already present**

Verify `createEventBus` is imported (it currently is, at line 19). Also ensure `Database` import covers the `new Database(":memory:")` line in sub-case B (already imported at line 16).

- [ ] **Step 5: Run the three new tests against current (pre-inline) code**

```bash
cd /Users/admin/void-os-wt/VOS-95/daemon
bun test test/adapters/mcp/tools/ask-agent.test.ts -t "non-AskAgentError wrapping"
bun test test/adapters/mcp/tools/ask-agent.test.ts -t "mint rollback"
bun test test/adapters/mcp/tools/ask-agent.test.ts -t "FAILED metadata fallback"
```

Expected: all three PASS. The handler already composes the behaviours under test; these are net-new handler-level coverage of branches previously asserted only through deleted sibling unit tests. If any fails, STOP and investigate before continuing — the task scope changes (would no longer be a pure refactor).

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/void-os-wt/VOS-95
git add daemon/test/adapters/mcp/tools/ask-agent.test.ts
git commit -m "VOS-95 T1: three handler-level tests (TDD pre-inline backfill)"
```

---

### Task 2: Inline 6 sibling src modules into ask-agent.ts

**Files:**
- Modify: `daemon/src/adapters/mcp/tools/ask-agent.ts` (rewrite — single self-contained module ~300 lines).

Do NOT delete sibling .ts files yet — Task 4 handles that. Sibling tests continue passing in the meantime because the sibling files still exist.

- [ ] **Step 1: Replace the contents of `daemon/src/adapters/mcp/tools/ask-agent.ts` with the inlined module**

Final file content (verbatim — paste as full replacement):

```typescript
// VOS-95: collapsed ask_agent MCP tool.
//
// Everything for ask_agent lives here: tool schema, error type + MCP error
// translator, depth probe, mint+flip transaction, bus-await helper, terminal
// translator, runAskAgent handler. Previously split into six siblings
// (-def, -errors, -depth, -mint, -wait, -result) — re-extract if a second
// production consumer appears for any of those concerns.

import type { Database } from "bun:sqlite";
import type { EventBus, DaemonEvent } from "../../../events";
import type { AgentDefn } from "../../../permissions/engine";

// -----------------------------------------------------------------------------
// Tool schema (was ask-agent-def.ts).
// -----------------------------------------------------------------------------

export const ASK_AGENT_TOOL_DEF = {
  name: "ask_agent",
  description:
    "Ask another agent (in the same Context). The daemon mints a child A2A Task; " +
    "this call suspends until the child reaches a terminal state and returns its " +
    "final assistant text.",
  inputSchema: {
    type: "object" as const,
    properties: {
      target_agent_id: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
      system_message: { type: "string" },
      // Caller-injected per ask_user precedent: stateless MCP transport.
      task_id: { type: "string", minLength: 1 },
      context_id: { type: "string", minLength: 1 },
    },
    required: ["target_agent_id", "message"],
  },
};

// -----------------------------------------------------------------------------
// Errors (was ask-agent-errors.ts).
// -----------------------------------------------------------------------------

export class AskAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskAgentError";
  }
}

export interface McpErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

function toMcpError(err: unknown): McpErrorResult {
  const text =
    err instanceof AskAgentError ? err.message :
    err instanceof Error ? `internal: ${err.message}` :
    "internal error";
  return { isError: true, content: [{ type: "text", text }] };
}

// -----------------------------------------------------------------------------
// Depth probe (was ask-agent-depth.ts).
// -----------------------------------------------------------------------------

const MAX_ASK_AGENT_DEPTH = 5;

function askAgentChainDepth(db: Database, taskId: string): number {
  const row = db
    .query(
      `
    WITH RECURSIVE chain(id, parent, n) AS (
      SELECT id, parent_task_id, 0 FROM tasks WHERE id = ?
      UNION ALL
      SELECT t.id, t.parent_task_id, c.n + 1
      FROM tasks t JOIN chain c ON t.id = c.parent
    )
    SELECT MAX(n) AS depth FROM chain
  `,
    )
    .get(taskId) as { depth: number | null } | undefined;
  return row?.depth ?? 0;
}

// -----------------------------------------------------------------------------
// Mint + flip (was ask-agent-mint.ts).
// -----------------------------------------------------------------------------

interface MintArgs {
  childId: string;
  contextId: string;
  parentId: string;
  targetAgent: string;
}

// Atomically mint a SUBMITTED child task and flip the parent
// WORKING -> WAITING_ON_AGENT. Single SQLite transaction; CAS failure on
// the parent flip rolls back the child INSERT so no orphan row is left.
function mintChildAndFlipParent(db: Database, a: MintArgs): void {
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.run(
      `INSERT INTO tasks
         (id, context_id, parent_task_id, state,
          cost_usd, tokens_in, tokens_out, metadata,
          created_at, updated_at, target_agent)
       VALUES (?, ?, ?, 'TASK_STATE_SUBMITTED',
               0, 0, 0, '{}', ?, ?, ?)`,
      [a.childId, a.contextId, a.parentId, now, now, a.targetAgent],
    );
    const res = db.run(
      `UPDATE tasks
         SET state = 'TASK_STATE_WAITING_ON_AGENT', updated_at = ?
       WHERE id = ? AND state = 'TASK_STATE_WORKING'`,
      [now, a.parentId],
    );
    if (res.changes === 0) {
      throw new AskAgentError("parent task not in WORKING state");
    }
  });
  tx();
}

// -----------------------------------------------------------------------------
// Bus-await helper (was ask-agent-wait.ts).
// -----------------------------------------------------------------------------

type TerminalState =
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED";

const TERMINALS: ReadonlySet<string> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
]);

function waitForChildTerminal(args: {
  db: Database;
  bus: EventBus;
  childTaskId: string;
}): Promise<TerminalState> {
  const { db, bus, childTaskId } = args;
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const settle = (s: TerminalState): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(s);
    };
    // Subscribe FIRST so any emit between this point and the DB recheck below
    // is captured by the handler.
    unsubscribe = bus.subscribe("task.state_changed", (ev: DaemonEvent) => {
      const p = ev.payload as { taskId?: string; state?: string } | undefined;
      if (!p || p.taskId !== childTaskId) return;
      if (p.state && TERMINALS.has(p.state)) {
        settle(p.state as TerminalState);
      }
    });
    // Race-guard: if the child already reached terminal before subscribe,
    // resolve from the DB.
    const row = db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string } | undefined;
    if (row && TERMINALS.has(row.state)) {
      settle(row.state as TerminalState);
    }
  });
}

// -----------------------------------------------------------------------------
// Terminal translator (was ask-agent-result.ts).
// -----------------------------------------------------------------------------

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

function translateChildResult(
  db: Database,
  childTaskId: string,
  state: string,
): ToolResult {
  if (state === "TASK_STATE_COMPLETED") {
    const row = db
      .query(
        `SELECT parts_text FROM messages
         WHERE task_id = ? AND role = 'ROLE_AGENT' AND parts_text != ''
         ORDER BY ts DESC, ord DESC LIMIT 1`,
      )
      .get(childTaskId) as { parts_text: string | null } | undefined;
    const text =
      row && row.parts_text && row.parts_text.length > 0
        ? row.parts_text
        : "(no message)";
    return { content: [{ type: "text", text }] };
  }
  if (state === "TASK_STATE_FAILED") {
    // Look up persisted errorMessage from tasks.metadata (written by
    // dispatch-child on FAILED). Fall back to "unknown" on absence or
    // malformed JSON.
    let resolved: string | null = null;
    const metaRow = db
      .query("SELECT metadata FROM tasks WHERE id = ?")
      .get(childTaskId) as { metadata: string | null } | undefined;
    if (metaRow?.metadata) {
      try {
        const parsed = JSON.parse(metaRow.metadata) as Record<string, unknown>;
        if (typeof parsed.errorMessage === "string") {
          resolved = parsed.errorMessage;
        }
      } catch {
        // malformed metadata — fall through to "unknown"
      }
    }
    throw new AskAgentError(`child task failed: ${resolved ?? "unknown"}`);
  }
  if (state === "TASK_STATE_CANCELED") {
    throw new AskAgentError("child task cancelled");
  }
  throw new AskAgentError(`unexpected child state: ${state}`);
}

// -----------------------------------------------------------------------------
// Handler.
// -----------------------------------------------------------------------------

export interface AskAgentCtx {
  db: Database;
  bus: EventBus;
  taskId: string;
  contextId: string;
  /** Resolve an AgentDefn by agent name. Throws if the name is unknown. */
  loadAgentDefn: (agentName: string) => AgentDefn;
  /** Dispatch the freshly-minted child onto the runner thread. */
  dispatchChildTask: (
    childTaskId: string,
    args: { agentName: string; message: string; systemMessage?: string },
  ) => Promise<void>;
  now: () => number;
}

export interface AskAgentArgs {
  target_agent_id: string;
  message: string;
  system_message?: string;
}

export async function runAskAgent(
  ctx: AskAgentCtx,
  args: AskAgentArgs,
): Promise<ToolResult | McpErrorResult> {
  try {
    // 1. Existence — agent_cards lookup (migration 0007).
    const exists = ctx.db
      .query("SELECT 1 AS one FROM agent_cards WHERE agent_name = ?")
      .get(args.target_agent_id);
    if (!exists) {
      throw new AskAgentError(`unknown agent: ${args.target_agent_id}`);
    }

    // 2. Caller identity. tasks has no agent_name column; the caller agent is
    // the context's agent_name.
    const callerRow = ctx.db
      .query(
        `SELECT c.agent_name AS agent_name
           FROM tasks t
           JOIN contexts c ON t.context_id = c.id
          WHERE t.id = ?`,
      )
      .get(ctx.taskId) as { agent_name: string } | undefined;
    if (!callerRow) {
      throw new AskAgentError("caller task missing");
    }
    const caller = ctx.loadAgentDefn(callerRow.agent_name);

    // 3. Permission — empty/undefined ask_agent_allow is permissive at the
    // agent level; an explicit array is an allowlist.
    if (
      caller.ask_agent_allow !== undefined &&
      !caller.ask_agent_allow.includes(args.target_agent_id)
    ) {
      throw new AskAgentError("permission denied");
    }

    // 4. Depth guard. About-to-mint child lives one level deeper, so reject
    // when current depth >= MAX_ASK_AGENT_DEPTH - 1.
    if (askAgentChainDepth(ctx.db, ctx.taskId) >= MAX_ASK_AGENT_DEPTH - 1) {
      throw new AskAgentError("ask_agent depth limit exceeded");
    }

    // 5. Allocate child task id.
    const childTaskId = crypto.randomUUID();

    // 6. Subscribe BEFORE mint so any state-changed emit fired between mint
    // commit and await is captured.
    const waitP = waitForChildTerminal({
      db: ctx.db,
      bus: ctx.bus,
      childTaskId,
    });

    // 7. Mint child + flip parent in single tx. Parent not WORKING -> rollback,
    // no child row remains.
    mintChildAndFlipParent(ctx.db, {
      childId: childTaskId,
      parentId: ctx.taskId,
      contextId: ctx.contextId,
      targetAgent: args.target_agent_id,
    });

    // VOS-89 Finding 4: emit parent's WORKING -> WAITING_ON_AGENT flip. The
    // mint runs in a sibling tx without bus access, so emission lives here.
    ctx.bus.emit({
      type: "task.state_changed",
      chatId: ctx.contextId,
      payload: {
        taskId: ctx.taskId,
        state: "TASK_STATE_WAITING_ON_AGENT",
      },
    });

    // 8. Dispatch child task.
    await ctx.dispatchChildTask(childTaskId, {
      agentName: args.target_agent_id,
      message: args.message,
      systemMessage: args.system_message,
    });

    // 9/10. Await child terminal with post-dispatch DB recheck to close the
    // "dispatcher flipped state without emitting" window.
    const postRow = ctx.db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string } | undefined;
    const state =
      postRow && TERMINALS.has(postRow.state)
        ? (postRow.state as TerminalState)
        : await waitP;

    // 11. Translate terminal -> tool result (or throw -> mcp error).
    return translateChildResult(ctx.db, childTaskId, state);
  } catch (e) {
    return toMcpError(e);
  }
}
```

Behavioural deltas vs pre-inline version:
- `translateChildResult` loses the unused `childError` parameter (always passed `null` by the handler). The `childError` argument was a test-only escape hatch and is replaced by the now-deleted sibling test.
- `MAX_ASK_AGENT_DEPTH` and `AskAgentError`/`McpErrorResult` move from exports to module-internal where unused externally; `AskAgentError`/`McpErrorResult` remain exported because handler tests reference them via the handler module (after Task 4 deletes the sibling test files that imported the sibling modules directly).

- [ ] **Step 2: Type-check + run full daemon test suite**

```bash
cd /Users/admin/void-os-wt/VOS-95/daemon
bun test 2>&1 | tail -30
```

Expected: all tests PASS. Sibling .test.ts files still pass (they import the sibling .ts files that still exist). Handler test passes (now backed by inlined code). Integration test `test/integration/ask-agent.test.ts` passes (imports handler module only).

If any sibling unit test breaks: STOP. The sibling .ts files are still on disk and untouched; the failure indicates a behavioural delta in the inlined version. Re-read the sibling and the inlined section side by side.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/void-os-wt/VOS-95
git add daemon/src/adapters/mcp/tools/ask-agent.ts
git commit -m "VOS-95 T2: inline 6 ask-agent siblings into single module"
```

---

### Task 3: Update index.ts to drop sibling import

**Files:**
- Modify: `daemon/src/adapters/mcp/index.ts:35-36`

- [ ] **Step 1: Replace two import lines**

Current (lines 35-36):

```typescript
import { ASK_AGENT_TOOL_DEF } from "./tools/ask-agent-def.ts";
import { runAskAgent, type AskAgentArgs } from "./tools/ask-agent.ts";
```

Replace with a single import:

```typescript
import {
  ASK_AGENT_TOOL_DEF,
  runAskAgent,
  type AskAgentArgs,
} from "./tools/ask-agent.ts";
```

- [ ] **Step 2: Type-check + smoke**

```bash
cd /Users/admin/void-os-wt/VOS-95/daemon
bun test test/adapters/mcp 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/void-os-wt/VOS-95
git add daemon/src/adapters/mcp/index.ts
git commit -m "VOS-95 T3: index.ts imports ASK_AGENT_TOOL_DEF from ask-agent.ts"
```

---

### Task 4: Delete 6 sibling src files + 6 sibling test files

**Files:**
- Delete:
  - `daemon/src/adapters/mcp/tools/ask-agent-def.ts`
  - `daemon/src/adapters/mcp/tools/ask-agent-depth.ts`
  - `daemon/src/adapters/mcp/tools/ask-agent-errors.ts`
  - `daemon/src/adapters/mcp/tools/ask-agent-mint.ts`
  - `daemon/src/adapters/mcp/tools/ask-agent-result.ts`
  - `daemon/src/adapters/mcp/tools/ask-agent-wait.ts`
  - `daemon/test/adapters/mcp/tools/ask-agent-depth.test.ts`
  - `daemon/test/adapters/mcp/tools/ask-agent-errors.test.ts`
  - `daemon/test/adapters/mcp/tools/ask-agent-mint.test.ts`
  - `daemon/test/adapters/mcp/tools/ask-agent-result.test.ts`
  - `daemon/test/adapters/mcp/tools/ask-agent-wait.test.ts`

(That is 6 src + 5 test files. The sixth sibling test from the spec count is `ask-agent-allow.test.ts` — see Step 1 below for the disposition decision.)

- [ ] **Step 1: Disposition for `daemon/test/agents/ask-agent-allow.test.ts`**

This file lives under `daemon/test/agents/`, not `daemon/test/adapters/mcp/tools/`. Inspect it:

```bash
cd /Users/admin/void-os-wt/VOS-95
head -30 daemon/test/agents/ask-agent-allow.test.ts
grep -n "import" daemon/test/agents/ask-agent-allow.test.ts | head
```

Decision rule:
- If it imports any of the now-deleted sibling .ts files → **delete it**. It is an internals test of a doomed seam.
- If it imports only `runAskAgent` from the handler (or asserts permission via integration) → **keep it**. It covers handler-level allow-list semantics.

Record the decision in the commit message. The task's Acceptance bullet "All 6 per-sibling test files deleted" was computed by the skill against `daemon/test/adapters/mcp/tools/ask-agent-*.test.ts` (5 siblings + 1 handler test) — the count was off by one; the Acceptance intent is "delete every sibling-internals test."

- [ ] **Step 2: Verify no remaining imports of the doomed sibling modules**

```bash
cd /Users/admin/void-os-wt/VOS-95
grep -rn "ask-agent-def\|ask-agent-depth\|ask-agent-errors\|ask-agent-mint\|ask-agent-result\|ask-agent-wait" daemon plugin 2>&1 | grep -v "\.git" || echo "no references"
```

Expected: `no references`. If any hit appears, fix the importer before deleting.

- [ ] **Step 3: Delete the files**

```bash
cd /Users/admin/void-os-wt/VOS-95
git rm \
  daemon/src/adapters/mcp/tools/ask-agent-def.ts \
  daemon/src/adapters/mcp/tools/ask-agent-depth.ts \
  daemon/src/adapters/mcp/tools/ask-agent-errors.ts \
  daemon/src/adapters/mcp/tools/ask-agent-mint.ts \
  daemon/src/adapters/mcp/tools/ask-agent-result.ts \
  daemon/src/adapters/mcp/tools/ask-agent-wait.ts \
  daemon/test/adapters/mcp/tools/ask-agent-depth.test.ts \
  daemon/test/adapters/mcp/tools/ask-agent-errors.test.ts \
  daemon/test/adapters/mcp/tools/ask-agent-mint.test.ts \
  daemon/test/adapters/mcp/tools/ask-agent-result.test.ts \
  daemon/test/adapters/mcp/tools/ask-agent-wait.test.ts
```

If Step 1 ruled `ask-agent-allow.test.ts` doomed, add it to the same `git rm` call.

- [ ] **Step 4: Full daemon test suite**

```bash
cd /Users/admin/void-os-wt/VOS-95/daemon
bun test 2>&1 | tail -30
```

Expected: all tests PASS. If any test fails citing a missing import, the grep in Step 2 missed it — revert with `git restore --staged --worktree <path>` and fix the importer.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/void-os-wt/VOS-95
git commit -m "VOS-95 T4: delete 6 ask-agent sibling src + sibling tests"
```

---

### Task 5: Full repo test suite

- [ ] **Step 1: Run full daemon suite**

```bash
cd /Users/admin/void-os-wt/VOS-95/daemon
bun test 2>&1 | tail -40
```

Expected: green.

- [ ] **Step 2: Sanity-check no orphan exports / dead imports**

```bash
cd /Users/admin/void-os-wt/VOS-95
grep -rn "ask-agent-" daemon plugin 2>&1 | grep -v "\.git" | grep -v "ask-agent.ts\|ask-agent.test.ts\|ask-agent.spec.ts\|ask-agent-allow.test.ts\|fixtures/ask-agent" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 3: Confirm `ask-agent.ts` line count is in target range**

```bash
wc -l /Users/admin/void-os-wt/VOS-95/daemon/src/adapters/mcp/tools/ask-agent.ts
```

Expected: 280-330 lines. Outside that range: investigate (likely dead code left over or something not inlined).

---

### Task 6: Code review gate

- [ ] **Step 1: Dispatch `superpowers:requesting-code-review` across the branch**

The orchestrator runs this — it dispatches a fresh subagent with the full diff of `task/VOS-95` vs `origin/main`.

- [ ] **Step 2: Address any review findings; re-run `bun test` after fixes**

- [ ] **Step 3: Log review SHA + outcome in task `## Work Log`**

Done when: review passes + Acceptance checklist fully ticked. Then `/done VOS-95`.
