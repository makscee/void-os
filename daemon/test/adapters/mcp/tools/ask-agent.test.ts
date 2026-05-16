// VOS-89 T8: runAskAgent handler composition tests.
//
// These exercise the four primary control-flow branches of runAskAgent:
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
import { runAskAgent, type AskAgentCtx } from "../../../../src/adapters/mcp/tools/ask-agent";
import type { AgentDefn } from "../../../../src/permissions/engine";

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

function buildCtx(
  db: Database,
  contextId: string,
  parentId: string,
  caller: AgentDefn,
  dispatchSim?: (childTaskId: string) => void | Promise<void>,
): AskAgentCtx {
  const bus = createEventBus();
  return {
    db,
    bus,
    taskId: parentId,
    contextId,
    loadAgentDefn: () => caller,
    dispatchChildTask: async (childTaskId) => {
      if (dispatchSim) await dispatchSim(childTaskId);
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}

describe("runAskAgent (composition)", () => {
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

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

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

    const result = await runAskAgent(ctx, {
      target_agent_id: "ghost",
      message: "hi",
    });

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

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

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

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

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

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

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

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

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

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

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
      const parent = i === 0 ? null : ids[i - 1];
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

    const result = await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

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

  test("Finding 4: emits task.state_changed when parent flips to WAITING_ON_AGENT", async () => {
    const { contextId, parentId } = seed(db);
    const caller: AgentDefn = { name: "maya" };

    // Capture every task.state_changed envelope so we can assert the
    // parent's WORKING -> WAITING_ON_AGENT transition is broadcast.
    const events: Array<{ taskId?: string; state?: string }> = [];

    // Drive child to terminal so runAskAgent returns. The dispatcher
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

    await runAskAgent(ctx, {
      target_agent_id: "journaler",
      message: "hi",
    });

    // Assert the parent's WAITING_ON_AGENT transition was emitted.
    const parentWaitEv = events.find(
      (e) => e.taskId === parentId && e.state === "TASK_STATE_WAITING_ON_AGENT",
    );
    expect(parentWaitEv).toBeTruthy();
  });
});
