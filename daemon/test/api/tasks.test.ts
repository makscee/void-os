// VOS-172: unit tests for GET /tasks — the global activity-list route.
//
// Strategy: drive `tasksApi(db)` directly via app.request — no buildApp,
// no orchestrator. Migrations run through 0016 (thin Context) via
// runMigrationsFromDir so the 0016 fk-rebuild marker is honoured.

import { test, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tasksApi } from "../../src/api/tasks.ts";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations.ts";
import type { TaskActivityItem } from "../../src/api/tasks.ts";

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

function makeDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
}

function seedContext(db: Database, title: string | null = null): string {
  const id = `ctx-${Math.random().toString(36).slice(2, 10)}`;
  db.run("INSERT INTO contexts (id, title, created_at) VALUES (?, ?, ?)", [
    id,
    title,
    Date.now(),
  ]);
  return id;
}

function seedTask(
  db: Database,
  t: {
    contextId: string;
    state?: string;
    agent?: string;
    lastEvent?: number;
    parentTaskId?: string | null;
  },
): string {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  const now = t.lastEvent ?? Date.now();
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, state, agent, last_event,
        cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, '{}', ?, ?)`,
    [
      id,
      t.contextId,
      t.parentTaskId ?? null,
      t.state ?? "TASK_STATE_WORKING",
      t.agent ?? "maya",
      t.lastEvent ?? now,
      now,
      now,
    ],
  );
  return id;
}

function seedMessage(
  db: Database,
  m: { contextId: string; taskId: string; text: string; ts?: number },
): void {
  const ts = m.ts ?? Date.now();
  db.run(
    `INSERT INTO messages (context_id, task_id, role, run_id, parts, parts_text, ord, ts)
     VALUES (?, ?, 'ROLE_AGENT', NULL, '[]', ?, ?, ?)`,
    [m.contextId, m.taskId, m.text, ts, ts],
  );
}

async function getTasks(
  db: Database,
  query = "",
): Promise<TaskActivityItem[]> {
  const app = tasksApi(db);
  const res = await app.request(`http://x/tasks${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as TaskActivityItem[];
}

describe("GET /tasks", () => {
  test("returns every Task across every Context, activity-sorted", async () => {
    const db = makeDb();
    const c1 = seedContext(db, "Context one");
    const c2 = seedContext(db, "Context two");
    seedTask(db, { contextId: c1, lastEvent: 1000 });
    seedTask(db, { contextId: c1, lastEvent: 3000 });
    seedTask(db, { contextId: c2, lastEvent: 2000 });

    const rows = await getTasks(db);
    expect(rows).toHaveLength(3);
    // DESC by last_event.
    expect(rows.map((r) => r.last_event)).toEqual([3000, 2000, 1000]);
    // Context grouping label threaded through.
    expect(rows.find((r) => r.last_event === 1000)?.context_title).toBe(
      "Context one",
    );
  });

  test("attaches a last_msg preview from the Task's most recent message", async () => {
    const db = makeDb();
    const c1 = seedContext(db, "Ctx");
    const tid = seedTask(db, { contextId: c1, lastEvent: 5000 });
    seedMessage(db, {
      contextId: c1,
      taskId: tid,
      text: "older message",
      ts: 100,
    });
    seedMessage(db, {
      contextId: c1,
      taskId: tid,
      text: "  the   newest   reply  ",
      ts: 200,
    });

    const rows = await getTasks(db);
    expect(rows).toHaveLength(1);
    // Whitespace collapsed, most-recent message wins.
    expect(rows[0]!.last_msg).toBe("the newest reply");
  });

  test("last_msg is null when a Task has no messages", async () => {
    const db = makeDb();
    const c1 = seedContext(db);
    seedTask(db, { contextId: c1 });
    const rows = await getTasks(db);
    expect(rows[0]!.last_msg).toBeNull();
  });

  test("terminal Tasks age out by default, kept with include_terminal", async () => {
    const db = makeDb();
    const c1 = seedContext(db);
    const old = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    seedTask(db, { contextId: c1, state: "TASK_STATE_WORKING" });
    seedTask(db, {
      contextId: c1,
      state: "TASK_STATE_COMPLETED",
      lastEvent: old,
    });

    const defaultRows = await getTasks(db);
    expect(defaultRows).toHaveLength(1);
    expect(defaultRows[0]!.state).toBe("TASK_STATE_WORKING");

    const allRows = await getTasks(db, "?include_terminal=1");
    expect(allRows).toHaveLength(2);
  });

  test("limit caps the number of rows", async () => {
    const db = makeDb();
    const c1 = seedContext(db);
    seedTask(db, { contextId: c1, lastEvent: 1 });
    seedTask(db, { contextId: c1, lastEvent: 2 });
    seedTask(db, { contextId: c1, lastEvent: 3 });
    const rows = await getTasks(db, "?limit=2");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.last_event)).toEqual([3, 2]);
  });
});
