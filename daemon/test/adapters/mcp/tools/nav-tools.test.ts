// VOS-169: MCP tool handler tests for list_tasks / list_children / get_task.
//
// Exercises the thin handler layer over makeNavRepo: structuredContent shape,
// error result for an unknown Task id, and the include_terminal flag wiring.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../../../src/adapters/sqlite/migrations";
import { makeListTasks } from "../../../../src/adapters/mcp/tools/list-tasks";
import { makeListChildren } from "../../../../src/adapters/mcp/tools/list-children";
import { makeGetTask } from "../../../../src/adapters/mcp/tools/get-task";

const MIGRATIONS = join(
  import.meta.dir,
  "../../../../src/adapters/sqlite/migrations",
);

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS);
  return db;
}

function seedContext(db: Database): string {
  const id = `ctx-${Math.random().toString(36).slice(2, 10)}`;
  db.run("INSERT INTO contexts (id, title, created_at) VALUES (?, NULL, ?)", [
    id,
    Date.now(),
  ]);
  return id;
}

function seedTask(
  db: Database,
  contextId: string,
  opts: { parentTaskId?: string; state?: string; lastEvent?: number } = {},
): string {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const lastEvent = opts.lastEvent ?? now;
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, state, agent, last_event,
        cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'maya', ?, 0, 0, 0, '{}', ?, ?)`,
    [id, contextId, opts.parentTaskId ?? null, opts.state ?? "TASK_STATE_WORKING", lastEvent, lastEvent, lastEvent],
  );
  return id;
}


test("list_tasks handler returns structuredContent.tasks", async () => {
  const db = freshDb();
  const c = seedContext(db);
  seedTask(db, c);
  seedTask(db, c);
  const handler = makeListTasks({ db });
  const res = await handler({});
  expect(res.isError).toBeFalsy();
  const sc = res.structuredContent as { tasks: unknown[] };
  expect(sc.tasks.length).toBe(2);
});

test("list_tasks handler include_terminal flag is wired through", async () => {
  const db = freshDb();
  const c = seedContext(db);
  // Seed a terminal Task two hours stale so a 1h recency window ages it out.
  seedTask(db, c, {
    state: "TASK_STATE_COMPLETED",
    lastEvent: Date.now() - 2 * 60 * 60 * 1000,
  });
  const handler = makeListTasks({ db });
  const excluded = await handler({ recency_hours: 1 });
  expect((excluded.structuredContent as { tasks: unknown[] }).tasks.length).toBe(0);
  const included = await handler({ include_terminal: true });
  expect((included.structuredContent as { tasks: unknown[] }).tasks.length).toBe(1);
});

test("list_children handler returns structuredContent.children", async () => {
  const db = freshDb();
  const c = seedContext(db);
  const root = seedTask(db, c);
  seedTask(db, c, { parentTaskId: root });
  seedTask(db, c, { parentTaskId: root });
  const handler = makeListChildren({ db });
  const res = await handler({ task_id: root });
  expect((res.structuredContent as { children: unknown[] }).children.length).toBe(2);
});

test("list_children handler returns empty children for a leaf Task", async () => {
  const db = freshDb();
  const c = seedContext(db);
  const leaf = seedTask(db, c);
  const handler = makeListChildren({ db });
  const res = await handler({ task_id: leaf });
  expect((res.structuredContent as { children: unknown[] }).children).toEqual([]);
});

test("get_task handler returns structuredContent.task", async () => {
  const db = freshDb();
  const c = seedContext(db);
  const id = seedTask(db, c);
  const handler = makeGetTask({ db });
  const res = await handler({ task_id: id });
  expect(res.isError).toBeFalsy();
  const sc = res.structuredContent as { task: { id: string; messages: unknown[] } };
  expect(sc.task.id).toBe(id);
  expect(Array.isArray(sc.task.messages)).toBe(true);
});

test("get_task handler returns TASK_NOT_FOUND for an unknown id", async () => {
  const db = freshDb();
  const handler = makeGetTask({ db });
  const res = await handler({ task_id: "nope" });
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toContain("TASK_NOT_FOUND");
});
