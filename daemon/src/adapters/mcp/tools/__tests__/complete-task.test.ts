// VOS-171: complete_task MCP tool handler.
//
// The handler reads the calling agent's Task id from `_meta.task_id`, flips
// the Task terminal via declareTaskTerminal, and emits task.state_changed.
// A parent cannot target a child — there is no taskId argument.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { makeChatRepo, getTaskState } from "../../../../chat/repo.ts";
import { makeCompleteTask } from "../complete-task.ts";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "adapters",
  "sqlite",
  "migrations",
);

function freshDb(): Database {
  const db = new Database(":memory:");
  const migs = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const m of migs) db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  return db;
}

/** Build a minimal RequestHandlerExtra carrying the runtime ids in `_meta`. */
function extraWith(meta: Record<string, unknown>): RequestHandlerExtra<any, any> {
  return { _meta: meta } as unknown as RequestHandlerExtra<any, any>;
}

const args = (state: "completed" | "failed", summary: string) =>
  ({ state, summary }) as { state: "completed" | "failed"; summary: string };

test("completed declaration flips the calling agent's Task to COMPLETED", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });

  const emitted: Array<{ t: string; p: Record<string, unknown> }> = [];
  const handler = makeCompleteTask({
    db,
    emit: (t, p) => emitted.push({ t, p }),
  });

  const res = await handler(
    args("completed", "delivered the summary"),
    extraWith({ task_id: c.task_id }),
  );

  expect(res.isError).toBeUndefined();
  expect(getTaskState(db, c.task_id)).toBe("TASK_STATE_COMPLETED");
  expect(emitted).toEqual([
    { t: "task.state_changed", p: { taskId: c.task_id, state: "TASK_STATE_COMPLETED" } },
  ]);
});

test("failed declaration flips the Task to FAILED", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  const handler = makeCompleteTask({ db });

  const res = await handler(
    args("failed", "could not reach the API"),
    extraWith({ task_id: c.task_id }),
  );
  expect(res.isError).toBeUndefined();
  expect(getTaskState(db, c.task_id)).toBe("TASK_STATE_FAILED");
});

test("missing _meta.task_id is an error result", async () => {
  const db = freshDb();
  const handler = makeCompleteTask({ db });
  const res = await handler(args("completed", "done"), extraWith({}));
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toContain(
    "COMPLETE_TASK_MISSING_TASK_ID",
  );
});

test("an unknown task id is an error result", async () => {
  const db = freshDb();
  const handler = makeCompleteTask({ db });
  const res = await handler(
    args("completed", "done"),
    extraWith({ task_id: "no-such-task" }),
  );
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toContain(
    "COMPLETE_TASK_UNKNOWN_TASK",
  );
});

test("a second declaration on a frozen Task is rejected (idempotent freeze)", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  const handler = makeCompleteTask({ db });

  await handler(args("completed", "first"), extraWith({ task_id: c.task_id }));
  const res = await handler(
    args("failed", "second attempt"),
    extraWith({ task_id: c.task_id }),
  );
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toContain(
    "COMPLETE_TASK_ALREADY_TERMINAL",
  );
  // the Task stays in its first (winning) terminal state.
  expect(getTaskState(db, c.task_id)).toBe("TASK_STATE_COMPLETED");
});

test("a parent cannot force-complete a child — the tool only targets _meta.task_id", async () => {
  // The handler has NO taskId argument. The only Task it can ever touch is
  // the one in `_meta.task_id` (the calling agent's own Task). Even if a
  // parent agent knew a child's id, it cannot pass it — `_meta` is injected
  // by the daemon per request, scoped to the caller.
  const db = freshDb();
  const repo = makeChatRepo(db);
  const parent = repo.create({ agent: "maya" });
  // a child Task under the same context.
  const childId = "child-task-id";
  db.run(
    "INSERT INTO tasks (id, context_id, parent_task_id, state, agent, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [childId, parent.id, parent.task_id, "TASK_STATE_WORKING", "worker", 1, 1],
  );
  const handler = makeCompleteTask({ db });

  // The parent agent calls complete_task — its `_meta.task_id` is its OWN
  // task. The child is untouched.
  await handler(
    args("completed", "parent done"),
    extraWith({ task_id: parent.task_id }),
  );
  expect(getTaskState(db, parent.task_id)).toBe("TASK_STATE_COMPLETED");
  expect(getTaskState(db, childId)).toBe("TASK_STATE_WORKING");
});
