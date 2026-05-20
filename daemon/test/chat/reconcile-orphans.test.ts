// VOS-89 T13: startup reconciler.
//
// Exercises `reconcileOrphans(db)` directly at the DB layer — no bus, no
// Provider, no spawn. Two orphan classes after a daemon mid-flight crash:
//
//   (a) Parent parked TASK_STATE_WAITING_ON_AGENT whose dispatched child
//       already reached terminal → parent flips back to WORKING (the
//       runtime resume listener was not running to do it inline).
//
//   (b) Non-terminal descendant of any TASK_STATE_CANCELED ancestor →
//       descendant flips to CANCELED (cascade orphan cleanup, since the
//       runtime cascade had not finished walking the tree).
//
// Schema deviations vs plan §T13 seed (consistent with T11/T12 tests):
//   - `tasks` has no `agent_name` column. Bind real NOT NULL columns:
//     state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at.
//   - `contexts` requires (id, agent_name, archived, created_at, updated_at).
//   - Use `runMigrationsFromDir` (canonical helper).
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { reconcileOrphans } from "../../src/chat/orchestrator";

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
    `INSERT INTO contexts (id, title, created_at)
     VALUES (?, NULL, strftime('%s','now'))`,
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

describe("reconcileOrphans", () => {
  test("(a) WAITING_ON_AGENT parent with terminal child → parent WORKING", () => {
    const db = freshDb();
    seedContext(db);
    // Parent parked waiting on its dispatched child; child already finished
    // (e.g. crashed after the child terminated but before the resume
    // listener flipped the parent).
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT");
    seedTask(db, "ch", "TASK_STATE_COMPLETED", "p");

    reconcileOrphans(db);

    expect(stateOf(db, "p")).toBe("TASK_STATE_WORKING");
    expect(stateOf(db, "ch")).toBe("TASK_STATE_COMPLETED");
  });

  test("(a) WAITING_ON_AGENT parent with FAILED child → parent WORKING", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT");
    seedTask(db, "ch", "TASK_STATE_FAILED", "p");

    reconcileOrphans(db);

    expect(stateOf(db, "p")).toBe("TASK_STATE_WORKING");
  });

  test("(a) WAITING_ON_AGENT parent with non-terminal child → parent untouched", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT");
    seedTask(db, "ch", "TASK_STATE_WORKING", "p");

    reconcileOrphans(db);

    // Child is still alive — daemon-restarted runtime listeners will flip
    // the parent when the child eventually terminates. Reconciler must
    // NOT pre-empt that.
    expect(stateOf(db, "p")).toBe("TASK_STATE_WAITING_ON_AGENT");
  });

  test("(b) CANCELED ancestor with WORKING descendant → descendant CANCELED", () => {
    const db = freshDb();
    seedContext(db);
    // Tree:
    //   p   (CANCELED)        ← ancestor (already terminal, untouched)
    //   └── c1  (WORKING)     ← cancelled
    //       └── gc1 (WORKING) ← cancelled (transitive)
    seedTask(db, "p", "TASK_STATE_CANCELED");
    seedTask(db, "c1", "TASK_STATE_WORKING", "p");
    seedTask(db, "gc1", "TASK_STATE_WORKING", "c1");

    reconcileOrphans(db);

    expect(stateOf(db, "p")).toBe("TASK_STATE_CANCELED");
    expect(stateOf(db, "c1")).toBe("TASK_STATE_CANCELED");
    expect(stateOf(db, "gc1")).toBe("TASK_STATE_CANCELED");
  });

  test("(b) CANCELED ancestor with COMPLETED descendant → preserved", () => {
    const db = freshDb();
    seedContext(db);
    // Sibling that finished cleanly before the cancel — never overwrite.
    seedTask(db, "p", "TASK_STATE_CANCELED");
    seedTask(db, "c1", "TASK_STATE_COMPLETED", "p");

    reconcileOrphans(db);

    expect(stateOf(db, "c1")).toBe("TASK_STATE_COMPLETED");
  });

  test("idempotent: second call is a no-op", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT");
    seedTask(db, "ch", "TASK_STATE_COMPLETED", "p");
    seedTask(db, "cp", "TASK_STATE_CANCELED");
    seedTask(db, "cc", "TASK_STATE_WORKING", "cp");

    reconcileOrphans(db);
    const after1 = {
      p: stateOf(db, "p"),
      ch: stateOf(db, "ch"),
      cp: stateOf(db, "cp"),
      cc: stateOf(db, "cc"),
    };

    reconcileOrphans(db);
    const after2 = {
      p: stateOf(db, "p"),
      ch: stateOf(db, "ch"),
      cp: stateOf(db, "cp"),
      cc: stateOf(db, "cc"),
    };

    expect(after2).toEqual(after1);
    expect(after1.p).toBe("TASK_STATE_WORKING");
    expect(after1.cc).toBe("TASK_STATE_CANCELED");
  });

  test("no orphans → no-op", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WORKING");
    seedTask(db, "c", "TASK_STATE_WORKING", "p");

    reconcileOrphans(db);

    expect(stateOf(db, "p")).toBe("TASK_STATE_WORKING");
    expect(stateOf(db, "c")).toBe("TASK_STATE_WORKING");
  });
});
