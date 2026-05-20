// VOS-154: ask_agent emits handoff-log dispatch + return entries.
//
// Exercises the production makeAskAgent handler in-process. Stubs the
// dispatchChildTask + handoffLog deps and constructs the minimum tasks /
// contexts / agent_cards rows needed for the gates to pass. Asserts:
//   - dispatch entry has the right from/to format and bundle text
//   - return entry has the right status (DONE on COMPLETED) and is linked
//     by parent_handoff_id
//   - handoffLog failures don't fail the dispatch (best-effort)

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrationsFromDir } from "../../../src/adapters/sqlite/migrations.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

const runMigrations = (db: Database): void => {
  runMigrationsFromDir(db, MIGRATIONS_DIR);
};
import { createEventBus } from "../../../src/events/index.ts";
import { makeAskAgent } from "../../../src/adapters/mcp/tools/ask-agent.ts";
import type {
  HandoffLog,
  DispatchEntry,
  ReturnEntry,
} from "../../../src/agents/handoff-log.ts";

interface StubHandoffLog extends HandoffLog {
  dispatches: DispatchEntry[];
  returns: ReturnEntry[];
}

function makeStubHandoffLog(opts?: {
  dispatchId?: string | null;
  returnId?: string | null;
  throwOnReturn?: boolean;
}): StubHandoffLog {
  const dispatches: DispatchEntry[] = [];
  const returns: ReturnEntry[] = [];
  return {
    dispatches,
    returns,
    async dispatch(entry) {
      dispatches.push(entry);
      return opts?.dispatchId ?? "disp-1";
    },
    async return(entry) {
      if (opts?.throwOnReturn) throw new Error("simulated hl failure");
      returns.push(entry);
      return opts?.returnId ?? "ret-1";
    },
  };
}

function seedSchema(db: Database): void {
  // Minimum rows: one context (with maya as caller), one parent task in
  // WORKING, and the child agent (`journaler`) registered in agent_cards.
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO contexts (id, title, created_at)
     VALUES ('ctx-1', NULL, ?)`,
    [now],
  );
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, parent_tool_call_id, state, agent,
        cost_usd, tokens_in, tokens_out, metadata,
        created_at, updated_at, target_agent)
     VALUES ('task-parent', 'ctx-1', NULL, NULL, 'TASK_STATE_WORKING', 'maya',
             0, 0, 0, '{}', ?, ?, 'maya')`,
    [now, now],
  );
  db.run(
    `INSERT INTO agent_cards (agent_name, card_json, source_mtime)
     VALUES ('journaler', '{"name":"journaler"}', ?)`,
    [now],
  );
}

function buildDeps(opts: {
  handoffLog: StubHandoffLog;
  // Optional: child terminal state to simulate.
  childTerminal?: "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED";
  // Optional: final assistant text seeded for the child task.
  finalText?: string;
}): {
  db: Database;
  bus: ReturnType<typeof createEventBus>;
  handler: ReturnType<typeof makeAskAgent>;
} {
  const db = new Database(":memory:");
  runMigrations(db);
  seedSchema(db);
  const bus = createEventBus();

  const dispatchChildTask = async (
    childTaskId: string,
    _args: { agentName: string; message: string; systemMessage?: string },
  ): Promise<void> => {
    // Flip the child to terminal state synchronously so the post-dispatch
    // recheck in ask_agent sees TERMINAL and short-circuits the bus wait.
    const terminal = opts.childTerminal ?? "TASK_STATE_COMPLETED";
    db.run(
      `UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`,
      [terminal, Math.floor(Date.now() / 1000), childTaskId],
    );
    if (opts.finalText) {
      db.run(
        `INSERT INTO messages
           (task_id, context_id, run_id, role, parts, parts_text, ord, ts)
         VALUES (?, 'ctx-1', NULL, 'ROLE_AGENT', '[]', ?, 0, ?)`,
        [childTaskId, opts.finalText, Math.floor(Date.now() / 1000)],
      );
    }
  };

  const handler = makeAskAgent({
    db,
    bus,
    loadAgentDefn: (name: string) => ({ name }),
    dispatchChildTask,
    now: () => Date.now(),
    handoffLog: opts.handoffLog,
    sessionId: "wm-test/1",
    milestone: "dogfood-void-os-workflow",
  });
  return { db, bus, handler };
}

const metaExtra = (taskId: string, toolCallId: string) =>
  ({
    _meta: { task_id: taskId, context_id: "ctx-1", tool_call_id: toolCallId },
  }) as unknown as Parameters<ReturnType<typeof makeAskAgent>>[1];

describe("VOS-154: ask_agent ⇄ handoff-log", () => {
  test("dispatch + return entries emitted around a COMPLETED child", async () => {
    const log = makeStubHandoffLog();
    const { handler } = buildDeps({
      handoffLog: log,
      finalText: "journaler summary text",
    });

    const result = await handler(
      { target_agent_id: "journaler", message: "summarise" },
      metaExtra("task-parent", "tu-1"),
    );
    // No isError flag = success path.
    expect((result as { isError?: boolean }).isError).toBeUndefined();

    // Dispatch entry.
    expect(log.dispatches.length).toBe(1);
    const d = log.dispatches[0]!;
    expect(d.fromAgentId).toBe("maya:task-parent");
    expect(d.toAgentId).toMatch(/^journaler:/);
    expect(d.taskId).toBe("task-parent");
    expect(d.milestone).toBe("dogfood-void-os-workflow");
    expect(d.session).toBe("wm-test/1");
    expect(d.bundleText).toBe("summarise");
    expect(d.expectedContract).toContain("ask_agent");

    // Return entry, swapped direction, linked.
    expect(log.returns.length).toBe(1);
    const r = log.returns[0]!;
    expect(r.fromAgentId).toMatch(/^journaler:/);
    expect(r.toAgentId).toBe("maya:task-parent");
    expect(r.status).toBe("DONE");
    expect(r.summary).toBe("journaler summary text");
    expect(r.bundleText).toBe("journaler summary text");
    expect(r.parentHandoffId).toBe("disp-1");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("FAILED child -> BLOCKED status in return entry", async () => {
    const log = makeStubHandoffLog();
    const { handler } = buildDeps({
      handoffLog: log,
      childTerminal: "TASK_STATE_FAILED",
    });

    const result = await handler(
      { target_agent_id: "journaler", message: "go" },
      metaExtra("task-parent", "tu-1"),
    );
    // FAILED bubbles up as an MCP error to the parent.
    expect((result as { isError?: boolean }).isError).toBe(true);

    expect(log.returns.length).toBe(1);
    expect(log.returns[0]!.status).toBe("BLOCKED");
  });

  test("handoffLog.return throw does not break ask_agent (best-effort)", async () => {
    const log = makeStubHandoffLog({ throwOnReturn: true });
    const { handler } = buildDeps({
      handoffLog: log,
      finalText: "ok",
    });

    const result = await handler(
      { target_agent_id: "journaler", message: "go" },
      metaExtra("task-parent", "tu-1"),
    );
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(log.dispatches.length).toBe(1);
    // Return throw was swallowed.
    expect(log.returns.length).toBe(0);
  });

  test("default deps (no handoffLog) does not throw — NULL adapter used", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedSchema(db);
    const bus = createEventBus();

    const dispatchChildTask = async (childTaskId: string): Promise<void> => {
      db.run(
        `UPDATE tasks SET state = 'TASK_STATE_COMPLETED', updated_at = ? WHERE id = ?`,
        [Math.floor(Date.now() / 1000), childTaskId],
      );
    };

    const handler = makeAskAgent({
      db,
      bus,
      loadAgentDefn: (name: string) => ({ name }),
      dispatchChildTask,
      now: () => Date.now(),
      // no handoffLog
    });

    const result = await handler(
      { target_agent_id: "journaler", message: "go" },
      metaExtra("task-parent", "tu-1"),
    );
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });
});
