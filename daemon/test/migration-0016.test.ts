// daemon/test/migration-0016.test.ts — VOS-168
// 0016 makes Context a thin grouping and moves agent/session/run state onto
// the Task. Verifies the column moves, the backfill, and that the 1:1
// Chat↔Task constraint is gone (a Context may now hold N root Tasks).
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appliedVersions,
  applyMigrations,
  loadMigrations,
} from "../src/adapters/sqlite/migrations";
import * as path from "node:path";

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../src/adapters/sqlite/migrations",
);

/** Apply every migration strictly before 0016, so the test can seed pre-0016
 *  rows and then run 0016 against them. */
function migrateTo0015(db: Database): void {
  const all = loadMigrations(MIGRATIONS_DIR);
  const upTo15 = all.filter((m) => m.version < "0016");
  applyMigrations(db, upTo15);
}

function migrate0016(db: Database): void {
  const all = loadMigrations(MIGRATIONS_DIR);
  const only16 = all.filter((m) => m.version === "0016_context_thin_grouping");
  applyMigrations(db, only16);
}

function cols(db: Database, table: string): string[] {
  return (
    db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

describe("migration 0016 — Context thin grouping", () => {
  it("contexts is thin: id, title, created_at only", () => {
    const db = new Database(":memory:");
    migrateTo0015(db);
    migrate0016(db);
    expect(cols(db, "contexts").sort()).toEqual(
      ["created_at", "id", "title"].sort(),
    );
    db.close();
  });

  it("tasks gains agent, session_id, current_run_id, last_event", () => {
    const db = new Database(":memory:");
    migrateTo0015(db);
    migrate0016(db);
    const tc = cols(db, "tasks");
    for (const c of ["agent", "session_id", "current_run_id", "last_event"]) {
      expect(tc).toContain(c);
    }
    // Pre-existing task columns survive the rebuild.
    for (const c of ["target_agent", "parent_tool_call_id", "parent_task_id"]) {
      expect(tc).toContain(c);
    }
    db.close();
  });

  it("backfills agent / session_id / current_run_id from the owning context", () => {
    const db = new Database(":memory:");
    migrateTo0015(db);
    const now = Date.now();
    db.run(
      `INSERT INTO contexts (id, agent_name, session_id, current_run_id, archived, created_at, updated_at)
         VALUES ('ctx-1','maya','sess-abc',NULL,0,?,?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
         VALUES ('task-1','ctx-1','TASK_STATE_WORKING',0,0,0,'{}',?,?)`,
      [now, now],
    );
    migrate0016(db);
    const row = db
      .query(
        "SELECT agent, session_id, last_event FROM tasks WHERE id = 'task-1'",
      )
      .get() as { agent: string; session_id: string; last_event: number };
    expect(row.agent).toBe("maya");
    expect(row.session_id).toBe("sess-abc");
    expect(row.last_event).toBe(now);
    db.close();
  });

  it("a Context may hold multiple root Tasks (1:1 constraint removed)", () => {
    const db = new Database(":memory:");
    migrateTo0015(db);
    migrate0016(db);
    const now = Date.now();
    db.run(
      "INSERT INTO contexts (id, title, created_at) VALUES ('ctx-2','topic',?)",
      [now],
    );
    // Two root tasks (parent_task_id IS NULL) under the same context.
    for (const id of ["root-a", "root-b"]) {
      db.run(
        `INSERT INTO tasks (id, context_id, state, agent, created_at, updated_at)
           VALUES (?, 'ctx-2','TASK_STATE_WORKING','maya',?,?)`,
        [id, now, now],
      );
    }
    const roots = db
      .query(
        "SELECT COUNT(*) AS n FROM tasks WHERE context_id='ctx-2' AND parent_task_id IS NULL",
      )
      .get() as { n: number };
    expect(roots.n).toBe(2);
    db.close();
  });

  it("registers 0016 in schema_migrations", () => {
    const db = new Database(":memory:");
    migrateTo0015(db);
    migrate0016(db);
    expect(appliedVersions(db).has("0016_context_thin_grouping")).toBe(true);
    db.close();
  });
});
