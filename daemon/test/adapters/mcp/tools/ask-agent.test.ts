// VOS-89 T8 (updated VOS-97 T7): ask_agent handler composition tests.
//
// These exercise the four primary control-flow branches of the ask_agent handler
// (built via makeAskAgent(deps)):
//   1. happy path -> mint child, flip parent, dispatch, await terminal, translate
//   2. unknown agent -> existence check rejects (no DB mutation)
//   3. permission denied -> caller's ask_agent_allow excludes target
//   4. depth limit exceeded -> chain depth >= MAX_ASK_AGENT_DEPTH - 1
//
// Schema reality (NOT what the plan claimed):
//   - `tasks` has no `agent_name` column. Caller identity is derived via
//     `tasks.context_id -> contexts.agent_name`.
//   - `tasks.target_agent` (migration 0011) is for cross-agent dispatch.
//   - Existence check goes via the `agent_cards` table (migration 0007).

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../../../src/events";
import { makeAskAgent, mintChildAndFlipParent, type AskAgentDeps } from "../../../../src/adapters/mcp/tools/ask-agent";
import type { AgentDefn } from "../../../../src/permissions/engine";

// Construct the canonical RequestHandlerExtra envelope carrying _meta.task_id /
// _meta.context_id per ADR-0002 (VOS-97 migration). tool_call_id is provided
// so mintChildAndFlipParent's parentToolCallId guard is satisfied.
function metaExtra(taskId: string, contextId: string, toolCallId = "test-tool-call-id") {
  return { _meta: { task_id: taskId, context_id: contextId, tool_call_id: toolCallId } } as any;
}

const MIGRATIONS = join(
  import.meta.dir,
  "../../../../src/adapters/sqlite/migrations",
);

function seed(db: Database): { contextId: string; parentId: string } {
  const now = Math.floor(Date.now() / 1000);
  const contextId = "ctx-1";
  const parentId = "parent-1";
  db.run(
    `INSERT INTO contexts (id, agent_name, title, created_at, updated_at)
     VALUES (?, 'maya', NULL, ?, ?)`,
    [contextId, now, now],
  );
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, state,
        cost_usd, tokens_in, tokens_out, metadata,
        created_at, updated_at, target_agent)
     VALUES (?, ?, NULL, 'TASK_STATE_WORKING',
             0, 0, 0, '{}', ?, ?, NULL)`,
    [parentId, contextId, now, now],
  );
  // Seed two known agents in agent_cards.
  db.run(
    `INSERT INTO agent_cards (agent_name, card_json, source_mtime)
     VALUES ('journaler', '{}', 0), ('other', '{}', 0)`,
  );
  return { contextId, parentId };
}

interface BuiltCtx {
  bus: ReturnType<typeof createEventBus>;
  deps: AskAgentDeps;
}

function buildCtx(
  db: Database,
  _contextId: string,
  _parentId: string,
  caller: AgentDefn,
  dispatchSim?: (childTaskId: string) => void | Promise<void>,
  emit?: (type: string, payload: Record<string, unknown>) => void,
): BuiltCtx {
  const bus = createEventBus();
  const deps: AskAgentDeps = {
    db,
    bus,
    loadAgentDefn: () => caller,
    dispatchChildTask: async (childTaskId) => {
      if (dispatchSim) await dispatchSim(childTaskId);
    },
    now: () => Math.floor(Date.now() / 1000),
    emit,
  };
  return { bus, deps };
}

describe("ask_agent handler (composition)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS);
  });

  test("happy path: mint, dispatch, terminal-resolve, translate", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };

    // Simulate child completion the moment it's "dispatched":
    // write a ROLE_AGENT message and flip child to COMPLETED + emit.
    const ctx = buildCtx(db, contextId, parentId, caller, async (childTaskId) => {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO messages (task_id, context_id, run_id, role, parts, parts_text, ts, ord)
         VALUES (?, ?, NULL, 'ROLE_AGENT', '[]', 'A', ?, 0)`,
        [childTaskId, contextId, now],
      );
      db.run(
        `UPDATE tasks SET state='TASK_STATE_COMPLETED', updated_at=? WHERE id=?`,
        [now, childTaskId],
      );
      ctx.bus.emit({
        type: "task.state_changed",
        chatId: contextId,
        payload: { taskId: childTaskId, state: "TASK_STATE_COMPLETED" },
      });
    });

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect(result).toEqual({ content: [{ type: "text", text: "A" }] });

    // Parent flipped to WAITING_ON_AGENT.
    const parent = db.query("SELECT state FROM tasks WHERE id=?").get(parentId) as
      | { state: string }
      | undefined;
    expect(parent?.state).toBe("TASK_STATE_WAITING_ON_AGENT");

    // Exactly one child minted with target_agent='journaler'.
    const childRows = db
      .query("SELECT id, parent_task_id, target_agent FROM tasks WHERE target_agent='journaler'")
      .all() as Array<{ id: string; parent_task_id: string; target_agent: string }>;
    expect(childRows.length).toBe(1);
    expect(childRows[0]!.parent_task_id).toBe(parentId);
  });

  test("unknown agent: existence check rejects", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };
    const ctx = buildCtx(db, contextId, parentId, caller);

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "ghost", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/unknown agent/i) }],
    });
    // Parent unchanged, no child minted.
    const parent = db.query("SELECT state FROM tasks WHERE id=?").get(parentId) as
      | { state: string }
      | undefined;
    expect(parent?.state).toBe("TASK_STATE_WORKING");
    const kids = db.query("SELECT count(*) as n FROM tasks WHERE parent_task_id=?").get(parentId) as
      | { n: number }
      | undefined;
    expect(kids?.n).toBe(0);
  });

  test("permission denied: ask_agent_allow excludes target", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya", ask_agent_allow: ["other"] };
    const ctx = buildCtx(db, contextId, parentId, caller);

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/permission denied/i) }],
    });
    const parent = db.query("SELECT state FROM tasks WHERE id=?").get(parentId) as
      | { state: string }
      | undefined;
    expect(parent?.state).toBe("TASK_STATE_WORKING");
  });

  test("child COMPLETED with no assistant message → '(no message)'", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };

    const ctx = buildCtx(db, contextId, parentId, caller, async (childTaskId) => {
      const now = Math.floor(Date.now() / 1000);
      // Intentionally insert NO ROLE_AGENT message; just flip state and emit.
      db.run(
        `UPDATE tasks SET state='TASK_STATE_COMPLETED', updated_at=? WHERE id=?`,
        [now, childTaskId],
      );
      ctx.bus.emit({
        type: "task.state_changed",
        chatId: contextId,
        payload: { taskId: childTaskId, state: "TASK_STATE_COMPLETED" },
      });
    });

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect(result).toEqual({ content: [{ type: "text", text: "(no message)" }] });
  });

  test("fast-completion race: terminal-before-subscribe still resolves via DB recheck", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };

    // Dispatcher flips state + writes message but does NOT emit. Handler must
    // resolve via the post-subscribe DB recheck.
    const ctx = buildCtx(db, contextId, parentId, caller, async (childTaskId) => {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO messages (task_id, context_id, run_id, role, parts, parts_text, ts, ord)
         VALUES (?, ?, NULL, 'ROLE_AGENT', '[]', 'FAST', ?, 0)`,
        [childTaskId, contextId, now],
      );
      db.run(
        `UPDATE tasks SET state='TASK_STATE_COMPLETED', updated_at=? WHERE id=?`,
        [now, childTaskId],
      );
      // intentionally no bus.emit
    });

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect(result).toEqual({ content: [{ type: "text", text: "FAST" }] });
  });

  test("child FAILED surfaces as tool-error", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };

    const ctx = buildCtx(db, contextId, parentId, caller, async (childTaskId) => {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `UPDATE tasks SET state='TASK_STATE_FAILED', updated_at=? WHERE id=?`,
        [now, childTaskId],
      );
      ctx.bus.emit({
        type: "task.state_changed",
        chatId: contextId,
        payload: { taskId: childTaskId, state: "TASK_STATE_FAILED" },
      });
    });

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ).toMatch(/child task failed/);
  });

  test("cancel cascade: child CANCELED → 'child task cancelled' tool-error", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };

    const ctx = buildCtx(db, contextId, parentId, caller, async (childTaskId) => {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `UPDATE tasks SET state='TASK_STATE_CANCELED', updated_at=? WHERE id=?`,
        [now, childTaskId],
      );
      ctx.bus.emit({
        type: "task.state_changed",
        chatId: contextId,
        payload: { taskId: childTaskId, state: "TASK_STATE_CANCELED" },
      });
    });

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ).toBe("child task cancelled");
  });

  test("depth limit exceeded", async () => {
    const { contextId } = seed(db);
    // Build a chain of 5 tasks: root -> g1 -> g2 -> g3 -> g4. Caller is g4 at
    // chain-depth 4. MAX_ASK_AGENT_DEPTH=5; comparison is `>= 5 - 1`, so 4>=4
    // triggers the depth error before mint.
    const now = Math.floor(Date.now() / 1000);
    const ids = ["root", "g1", "g2", "g3", "g4"];
    for (let i = 0; i < ids.length; i++) {
      const parent = i === 0 ? null : ids[i - 1]!;
      db.run(
        `INSERT INTO tasks
           (id, context_id, parent_task_id, state,
            cost_usd, tokens_in, tokens_out, metadata,
            created_at, updated_at, target_agent)
         VALUES (?, ?, ?, 'TASK_STATE_WORKING',
                 0, 0, 0, '{}', ?, ?, NULL)`,
        [ids[i]!, contextId, parent, now, now],
      );
    }
    const caller: AgentDefn = { name: "maya" };
    const ctx = buildCtx(db, contextId, "g4", caller);

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra("g4", contextId),
    );

    expect(result).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: expect.stringMatching(/depth limit exceeded/i) },
      ],
    });
    // No child minted.
    const kids = db
      .query("SELECT count(*) as n FROM tasks WHERE parent_task_id='g4'")
      .get() as { n: number };
    expect(kids.n).toBe(0);
  });

  test("non-AskAgentError wrapping: loadAgentDefn plain Error → internal: prefix", async () => {
    const { contextId, parentId } = seed(db);
    const bus = createEventBus();
    const deps: AskAgentDeps = {
      db,
      bus,
      loadAgentDefn: () => {
        throw new Error("boom-defn");
      },
      dispatchChildTask: async () => {},
      now: () => Math.floor(Date.now() / 1000),
    };

    const result = await makeAskAgent(deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

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

  test("mint rollback: parent not in WORKING leaves no orphan child", async () => {
    const { contextId, parentId } = seed(db);
    // Flip parent out of WORKING before the call so mint's CAS-update fails.
    db.run(
      `UPDATE tasks SET state='TASK_STATE_SUBMITTED' WHERE id=?`,
      [parentId],
    );
    const caller: AgentDefn = { name: "maya" };
    const ctx = buildCtx(db, contextId, parentId, caller);

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/parent task not in WORKING/i) }],
    });
    const kids = db
      .query("SELECT count(*) as n FROM tasks WHERE parent_task_id=?")
      .get(parentId) as { n: number } | undefined;
    expect(kids?.n).toBe(0);
  });

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
      const result = await makeAskAgent(ctx.deps)(
        { target_agent_id: "journaler", message: "hi" },
        metaExtra(parentId, contextId),
      );
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
      const result = await makeAskAgent(ctx.deps)(
        { target_agent_id: "journaler", message: "hi" },
        metaExtra(parentId, contextId),
      );
      expect(
        (result as { content: Array<{ text: string }> }).content[0]!.text,
      ).toMatch(/unknown/);
    }
  });

  // VOS-91 T2: mintChildAndFlipParent persists parent_tool_call_id
  test("mint: persists parent_tool_call_id on the child row", () => {
    const { contextId, parentId } = seed(db);
    mintChildAndFlipParent(db, {
      childId: "task-child",
      contextId,
      parentId,
      targetAgent: "journaler",
      parentToolCallId: "tool-call-abc",
    });
    const row = db.query("SELECT parent_tool_call_id FROM tasks WHERE id=?")
      .get("task-child") as { parent_tool_call_id: string | null };
    expect(row.parent_tool_call_id).toBe("tool-call-abc");
  });

  test("mint: throws if parentToolCallId is missing", () => {
    const { contextId, parentId } = seed(db);
    expect(() =>
      // @ts-expect-error — exercising the runtime guard
      mintChildAndFlipParent(db, {
        childId: "task-child", contextId, parentId,
        targetAgent: "journaler",
      }),
    ).toThrow(/parentToolCallId required/);
  });

  test("handler: missing tool_call_id returns structured error, does not throw", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };
    const ctx = buildCtx(db, contextId, parentId, caller);

    // Pass _meta without tool_call_id; task_id is valid so the taskId guard passes.
    const extraNoToolCallId = {
      _meta: { task_id: parentId, context_id: contextId },
    } as any;

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      extraNoToolCallId,
    );

    expect(result.isError).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "ASK_AGENT_MISSING_TOOL_CALL_ID",
    );
    // Parent must be untouched; no child minted.
    const parent = db.query("SELECT state FROM tasks WHERE id=?").get(parentId) as
      | { state: string }
      | undefined;
    expect(parent?.state).toBe("TASK_STATE_WORKING");
    const kids = db
      .query("SELECT count(*) as n FROM tasks WHERE parent_task_id=?")
      .get(parentId) as { n: number } | undefined;
    expect(kids?.n).toBe(0);
  });

  test("handler: empty-string tool_call_id returns structured error, does not throw", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };
    const ctx = buildCtx(db, contextId, parentId, caller);

    const extraEmptyToolCallId = {
      _meta: { task_id: parentId, context_id: contextId, tool_call_id: "" },
    } as any;

    const result = await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      extraEmptyToolCallId,
    );

    expect(result.isError).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "ASK_AGENT_MISSING_TOOL_CALL_ID",
    );
  });

  // VOS-91 T3: emits chat.child_task_started after mint, before dispatch
  test("emits chat.child_task_started after mint commits", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };

    const captured: Array<Record<string, unknown>> = [];
    const emitSpy = (type: string, payload: Record<string, unknown>) => {
      if (type === "chat.child_task_started") captured.push(payload);
    };

    const ctx = buildCtx(
      db,
      contextId,
      parentId,
      caller,
      async (childTaskId) => {
        // Drive child to COMPLETED so the handler can return.
        const now = Math.floor(Date.now() / 1000);
        db.run(
          `INSERT INTO messages (task_id, context_id, run_id, role, parts, parts_text, ts, ord)
           VALUES (?, ?, NULL, 'ROLE_AGENT', '[]', 'OK', ?, 0)`,
          [childTaskId, contextId, now],
        );
        db.run(
          `UPDATE tasks SET state='TASK_STATE_COMPLETED', updated_at=? WHERE id=?`,
          [now, childTaskId],
        );
        ctx.bus.emit({
          type: "task.state_changed",
          chatId: contextId,
          payload: { taskId: childTaskId, state: "TASK_STATE_COMPLETED" },
        });
      },
      emitSpy,
    );

    await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      chat_id: contextId,
      parent_task_id: parentId,
      parent_tool_call_id: "test-tool-call-id",
      agent: "journaler",
    });
    expect(typeof captured[0]!.child_task_id).toBe("string");
    expect((captured[0]!.child_task_id as string).length).toBeGreaterThan(0);
  });

  test("Finding 4: emits task.state_changed when parent flips to WAITING_ON_AGENT", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };

    // Capture every task.state_changed envelope so we can assert the
    // parent's WORKING -> WAITING_ON_AGENT transition is broadcast.
    const events: Array<{ taskId?: string; state?: string }> = [];

    // Drive child to terminal so the ask_agent handler returns. The dispatcher
    // simulator runs AFTER the parent flip emit, but we capture both.
    const ctx = buildCtx(db, contextId, parentId, caller, async (childTaskId) => {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO messages (task_id, context_id, run_id, role, parts, parts_text, ts, ord)
         VALUES (?, ?, NULL, 'ROLE_AGENT', '[]', 'OK', ?, 0)`,
        [childTaskId, contextId, now],
      );
      db.run(
        `UPDATE tasks SET state='TASK_STATE_COMPLETED', updated_at=? WHERE id=?`,
        [now, childTaskId],
      );
      ctx.bus.emit({
        type: "task.state_changed",
        chatId: contextId,
        payload: { taskId: childTaskId, state: "TASK_STATE_COMPLETED" },
      });
    });
    ctx.bus.subscribe("task.state_changed", (ev) => {
      events.push(ev.payload as { taskId?: string; state?: string });
    });

    await makeAskAgent(ctx.deps)(
      { target_agent_id: "journaler", message: "hi" },
      metaExtra(parentId, contextId),
    );

    // Assert the parent's WAITING_ON_AGENT transition was emitted.
    const parentWaitEv = events.find(
      (e) => e.taskId === parentId && e.state === "TASK_STATE_WAITING_ON_AGENT",
    );
    expect(parentWaitEv).toBeTruthy();
  });
});
