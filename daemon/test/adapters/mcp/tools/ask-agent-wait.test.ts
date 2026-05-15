import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../../../src/events";
import { waitForChildTerminal } from "../../../../src/adapters/mcp/tools/ask-agent-wait";

const MIGRATIONS = join(
  import.meta.dir,
  "../../../../src/adapters/sqlite/migrations",
);

function setupDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS);
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO contexts (id, agent_name, title, created_at, updated_at)
     VALUES ('c', 'a', NULL, ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, state,
        cost_usd, tokens_in, tokens_out, metadata,
        created_at, updated_at)
     VALUES ('child', 'c', NULL, 'TASK_STATE_WORKING',
             0, 0, 0, '{}', ?, ?)`,
    [now, now],
  );
  return db;
}

describe("waitForChildTerminal", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });

  test("resolves with COMPLETED when bus emits", async () => {
    const bus = createEventBus();
    const p = waitForChildTerminal({ db, bus, childTaskId: "child" });
    setTimeout(() => {
      db.run(`UPDATE tasks SET state='TASK_STATE_COMPLETED' WHERE id='child'`);
      bus.emit({
        type: "task.state_changed",
        chatId: "c",
        payload: { taskId: "child", state: "TASK_STATE_COMPLETED" },
      });
    }, 5);
    const state = await p;
    expect(state).toBe("TASK_STATE_COMPLETED");
  });

  test("ignores events for other tasks", async () => {
    const bus = createEventBus();
    const p = waitForChildTerminal({ db, bus, childTaskId: "child" });
    bus.emit({
      type: "task.state_changed",
      chatId: "c",
      payload: { taskId: "other", state: "TASK_STATE_COMPLETED" },
    });
    setTimeout(() => {
      db.run(`UPDATE tasks SET state='TASK_STATE_FAILED' WHERE id='child'`);
      bus.emit({
        type: "task.state_changed",
        chatId: "c",
        payload: { taskId: "child", state: "TASK_STATE_FAILED" },
      });
    }, 5);
    expect(await p).toBe("TASK_STATE_FAILED");
  });

  test("ignores non-terminal states", async () => {
    const bus = createEventBus();
    const p = waitForChildTerminal({ db, bus, childTaskId: "child" });
    bus.emit({
      type: "task.state_changed",
      chatId: "c",
      payload: { taskId: "child", state: "TASK_STATE_WORKING" },
    });
    setTimeout(() => {
      db.run(`UPDATE tasks SET state='TASK_STATE_CANCELED' WHERE id='child'`);
      bus.emit({
        type: "task.state_changed",
        chatId: "c",
        payload: { taskId: "child", state: "TASK_STATE_CANCELED" },
      });
    }, 5);
    expect(await p).toBe("TASK_STATE_CANCELED");
  });

  test("fast completion: resolves from DB if already terminal at post-subscribe check", async () => {
    db.run(`UPDATE tasks SET state='TASK_STATE_COMPLETED' WHERE id='child'`);
    const bus = createEventBus();
    // No emit. waitForChildTerminal must read DB after subscribe and resolve immediately.
    expect(
      await waitForChildTerminal({ db, bus, childTaskId: "child" }),
    ).toBe("TASK_STATE_COMPLETED");
  });
});
