// VOS-89 T12: cancel cascade.
//
// `cascadeCancel(db, rootTaskId)` walks the task tree under `rootTaskId`
// (recursive CTE), flips every NON-terminal descendant to TASK_STATE_CANCELED
// in a SINGLE transaction, and returns the ids it cancelled (in any order).
// The root itself is NOT touched — caller cancels it separately.
//
// Schema deviations vs plan §T12 seed:
//   - `tasks` has no `agent_name` column. Bind real NOT NULL columns:
//     state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at.
//   - `contexts` requires (id, agent_name, archived, created_at, updated_at).
//   - Use `runMigrationsFromDir` (the canonical helper used by all other
//     daemon tests) — NOT inline `db.exec(sql)`.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { cascadeCancel } from "../../src/chat/orchestrator";

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "../../src/adapters/sqlite/migrations",
);

const freshDb = (): Database => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
};

const seedContext = (db: Database, id = "c"): void => {
  db.run(
    `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at)
     VALUES (?, 'maya', 0, strftime('%s','now'), strftime('%s','now'))`,
    [id],
  );
};

const seedTask = (
  db: Database,
  id: string,
  state: string,
  parent_task_id: string | null = null,
): void => {
  db.run(
    `INSERT INTO tasks (id, context_id, state, parent_task_id,
                        cost_usd, tokens_in, tokens_out, metadata,
                        created_at, updated_at)
     VALUES (?, 'c', ?, ?, 0, 0, 0, '{}',
             strftime('%s','now'), strftime('%s','now'))`,
    [id, state, parent_task_id],
  );
};

const stateOf = (db: Database, id: string): string => {
  const row = db
    .query("SELECT state FROM tasks WHERE id = ?")
    .get(id) as { state: string } | undefined;
  if (!row) throw new Error(`task not found: ${id}`);
  return row.state;
};

describe("cascadeCancel", () => {
  test("cancels non-terminal descendants, skips terminal, leaves root alone", () => {
    // Tree:
    //   p   (WORKING)        ← root, NOT touched
    //   ├── c1  (WORKING)    ← cancelled
    //   │   └── gc1 (WORKING) ← cancelled (transitive)
    //   └── c2  (COMPLETED)  ← skipped (terminal)
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WORKING");
    seedTask(db, "c1", "TASK_STATE_WORKING", "p");
    seedTask(db, "c2", "TASK_STATE_COMPLETED", "p");
    seedTask(db, "gc1", "TASK_STATE_WORKING", "c1");

    const cancelled = cascadeCancel(db, "p");

    expect(cancelled.sort()).toEqual(["c1", "gc1"]);
    expect(stateOf(db, "p")).toBe("TASK_STATE_WORKING"); // root untouched
    expect(stateOf(db, "c1")).toBe("TASK_STATE_CANCELED");
    expect(stateOf(db, "gc1")).toBe("TASK_STATE_CANCELED");
    expect(stateOf(db, "c2")).toBe("TASK_STATE_COMPLETED"); // terminal preserved
  });

  test("returns empty list when no non-terminal descendants exist", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WORKING");
    seedTask(db, "c1", "TASK_STATE_FAILED", "p");
    seedTask(db, "c2", "TASK_STATE_CANCELED", "p");

    const cancelled = cascadeCancel(db, "p");

    expect(cancelled).toEqual([]);
    expect(stateOf(db, "c1")).toBe("TASK_STATE_FAILED");
    expect(stateOf(db, "c2")).toBe("TASK_STATE_CANCELED");
  });

  test("cancels WAITING_ON_AGENT and INPUT_REQUIRED descendants", () => {
    // Both non-terminal "parked" states should be cancelled.
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WORKING");
    seedTask(db, "c1", "TASK_STATE_WAITING_ON_AGENT", "p");
    seedTask(db, "c2", "TASK_STATE_INPUT_REQUIRED", "p");

    const cancelled = cascadeCancel(db, "p");

    expect(cancelled.sort()).toEqual(["c1", "c2"]);
    expect(stateOf(db, "c1")).toBe("TASK_STATE_CANCELED");
    expect(stateOf(db, "c2")).toBe("TASK_STATE_CANCELED");
  });

  test("returns empty list when root has no descendants at all", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WORKING");

    const cancelled = cascadeCancel(db, "p");

    expect(cancelled).toEqual([]);
    expect(stateOf(db, "p")).toBe("TASK_STATE_WORKING");
  });
});
