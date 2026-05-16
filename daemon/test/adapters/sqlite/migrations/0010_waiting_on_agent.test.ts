// Migration 0010 — extend tasks.state CHECK with TASK_STATE_WAITING_ON_AGENT.
// Note: tasks has no agent_name column (it lives on contexts); the FK is
// context_id -> contexts(id), so the test seeds a contexts row first.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../../../src/adapters/sqlite/migrations";

const MIGRATIONS_DIR = join(import.meta.dir, "../../../../src/adapters/sqlite/migrations");

const freshDb = (): Database => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
};

const seedContext = (db: Database, id = "c1"): void => {
  db.run(
    `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at)
     VALUES (?, 'maya', 0, strftime('%s','now'), strftime('%s','now'))`,
    [id],
  );
};

describe("migration 0010_waiting_on_agent", () => {
  test("tasks.state accepts TASK_STATE_WAITING_ON_AGENT", () => {
    const db = freshDb();
    seedContext(db);
    db.run(`
      INSERT INTO tasks (id, context_id, state, created_at, updated_at)
      VALUES ('t1', 'c1', 'TASK_STATE_WAITING_ON_AGENT',
              strftime('%s','now'), strftime('%s','now'))
    `);
    const row = db.query("SELECT state FROM tasks WHERE id='t1'").get() as { state: string };
    expect(row.state).toBe("TASK_STATE_WAITING_ON_AGENT");
  });

  test("tasks.state still rejects garbage", () => {
    const db = freshDb();
    seedContext(db);
    expect(() =>
      db.run(`
        INSERT INTO tasks (id, context_id, state, created_at, updated_at)
        VALUES ('t2', 'c1', 'NOT_A_STATE',
                strftime('%s','now'), strftime('%s','now'))
      `),
    ).toThrow();
  });

  test("parent_task_id index preserved after rebuild", () => {
    const db = freshDb();
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names.some((n) => n.includes("parent"))).toBe(true);
  });
});
