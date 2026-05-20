// VOS-91 T8: mountChatTaskStateFanout — chat.task.state_changed WS fan-out.
//
// Verifies that bus task.state_changed events are translated into
// chat.task.state_changed frames and dispatched via broadcast().

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../src/events/index";
import {
  mountChatTaskStateFanout,
  type TaskStateChangedPayload,
} from "../../src/api/chat";

const MIG = path.resolve(__dirname, "../../src/adapters/sqlite/migrations");

function makeDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIG);
  return db;
}

function seedContext(db: Database, ctxId: string): void {
  const now = Date.now();
  db.run(
    `INSERT INTO contexts (id, title, created_at)
     VALUES (?, NULL, ?)`,
    [ctxId, now],
  );
}

function seedTask(
  db: Database,
  opts: {
    id: string;
    contextId: string;
    parentTaskId: string | null;
    state: string;
    metadata?: string;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, parent_tool_call_id,
        state, cost_usd, tokens_in, tokens_out,
        metadata, target_agent, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 0, 0, 0, ?, NULL, ?, ?)`,
    [
      opts.id,
      opts.contextId,
      opts.parentTaskId,
      opts.state,
      opts.metadata ?? "{}",
      now,
      now,
    ],
  );
}

describe("mountChatTaskStateFanout", () => {
  it("emits chat.task.state_changed with error field on FAILED task that has errorMessage in metadata", () => {
    const db = makeDb();
    const bus = createEventBus({ db });

    seedContext(db, "ctx-1");
    seedTask(db, {
      id: "task-fail",
      contextId: "ctx-1",
      parentTaskId: "task-root",
      state: "TASK_STATE_FAILED",
      metadata: JSON.stringify({ errorMessage: "cc-spawner: provider exploded" }),
    });

    const captured: Array<{
      chatId: string;
      frame: { type: "chat.task.state_changed"; payload: TaskStateChangedPayload };
    }> = [];

    const unsubscribe = mountChatTaskStateFanout({
      db,
      bus,
      broadcast: (chatId, frame) => captured.push({ chatId, frame }),
    });

    bus.emit({
      type: "task.state_changed",
      payload: { taskId: "task-fail", state: "TASK_STATE_FAILED" },
    });

    unsubscribe();

    expect(captured).toHaveLength(1);
    const { chatId, frame } = captured[0]!;
    expect(chatId).toBe("ctx-1");
    expect(frame.type).toBe("chat.task.state_changed");
    const p = frame.payload;
    expect(p.chat_id).toBe("ctx-1");
    expect(p.task_id).toBe("task-fail");
    expect(p.parent_task_id).toBe("task-root");
    expect(p.state).toBe("FAILED");
    expect(p.error).toBe("cc-spawner: provider exploded");
  });

  it("emits chat.task.state_changed without error field on COMPLETED root task", () => {
    const db = makeDb();
    const bus = createEventBus({ db });

    seedContext(db, "ctx-2");
    seedTask(db, {
      id: "task-root",
      contextId: "ctx-2",
      parentTaskId: null,
      state: "TASK_STATE_COMPLETED",
      metadata: "{}",
    });

    const captured: Array<{
      chatId: string;
      frame: { type: "chat.task.state_changed"; payload: TaskStateChangedPayload };
    }> = [];

    const unsubscribe = mountChatTaskStateFanout({
      db,
      bus,
      broadcast: (chatId, frame) => captured.push({ chatId, frame }),
    });

    bus.emit({
      type: "task.state_changed",
      payload: { taskId: "task-root", state: "TASK_STATE_COMPLETED" },
    });

    unsubscribe();

    expect(captured).toHaveLength(1);
    const { chatId, frame } = captured[0]!;
    expect(chatId).toBe("ctx-2");
    expect(frame.type).toBe("chat.task.state_changed");
    const p = frame.payload;
    expect(p.chat_id).toBe("ctx-2");
    expect(p.task_id).toBe("task-root");
    expect(p.parent_task_id).toBeNull();
    expect(p.state).toBe("COMPLETED");
    expect("error" in p).toBe(false);
  });
});
