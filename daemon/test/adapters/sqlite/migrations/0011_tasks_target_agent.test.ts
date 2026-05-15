// Migration 0011 — tasks.target_agent (nullable TEXT) for cross-agent dispatch.
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

describe("migration 0011_tasks_target_agent", () => {
  test("tasks accepts and reads back target_agent='journaler'", () => {
    const db = freshDb();
    seedContext(db);
    db.run(`
      INSERT INTO tasks (id, context_id, state, target_agent, created_at, updated_at)
      VALUES ('t1', 'c1', 'TASK_STATE_SUBMITTED', 'journaler',
              strftime('%s','now'), strftime('%s','now'))
    `);
    const row = db
      .query("SELECT target_agent FROM tasks WHERE id='t1'")
      .get() as { target_agent: string | null };
    expect(row.target_agent).toBe("journaler");
  });

  test("inserts without target_agent default to NULL (pre-VOS-89 rows)", () => {
    const db = freshDb();
    seedContext(db);
    db.run(`
      INSERT INTO tasks (id, context_id, state, created_at, updated_at)
      VALUES ('t2', 'c1', 'TASK_STATE_SUBMITTED',
              strftime('%s','now'), strftime('%s','now'))
    `);
    const row = db
      .query("SELECT target_agent FROM tasks WHERE id='t2'")
      .get() as { target_agent: string | null };
    expect(row.target_agent).toBeNull();
  });
});
