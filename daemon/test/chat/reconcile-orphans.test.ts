// VOS-89 T13 / VOS-170: startup reconciler — cancel-cascade orphan cleanup.
//
// Exercises `reconcileOrphans(db)` directly at the DB layer — no bus, no
// Provider, no spawn. After a daemon mid-flight crash a non-terminal
// descendant of any TASK_STATE_CANCELED ancestor must be flipped to CANCELED
// (the runtime cascade had not finished walking the tree).
//
// VOS-170: the WAITING_ON_AGENT parent-resume class moved OUT of
// `reconcileOrphans` (a bare flip is not a resume — the parent's CC
// subprocess died with the daemon). That class is now covered by
// `reconcile-waiting-parents.test.ts`.
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

describe("reconcileOrphans (cancel cascade)", () => {
  test("CANCELED ancestor with WORKING descendant → descendant CANCELED", () => {
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

  test("CANCELED ancestor with COMPLETED descendant → preserved", () => {
    const db = freshDb();
    seedContext(db);
    // Sibling that finished cleanly before the cancel — never overwrite.
    seedTask(db, "p", "TASK_STATE_CANCELED");
    seedTask(db, "c1", "TASK_STATE_COMPLETED", "p");

    reconcileOrphans(db);

    expect(stateOf(db, "c1")).toBe("TASK_STATE_COMPLETED");
  });

  test("VOS-170: WAITING_ON_AGENT parent is NOT touched by reconcileOrphans", () => {
    const db = freshDb();
    seedContext(db);
    // A parked parent whose child finished. reconcileOrphans must leave it
    // alone — the durable resume is reconcileWaitingParents' job now (it
    // needs a provider to re-drive, which reconcileOrphans does not have).
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT");
    seedTask(db, "ch", "TASK_STATE_COMPLETED", "p");

    reconcileOrphans(db);

    expect(stateOf(db, "p")).toBe("TASK_STATE_WAITING_ON_AGENT");
  });

  test("idempotent: second call is a no-op", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "cp", "TASK_STATE_CANCELED");
    seedTask(db, "cc", "TASK_STATE_WORKING", "cp");

    reconcileOrphans(db);
    const after1 = { cp: stateOf(db, "cp"), cc: stateOf(db, "cc") };

    reconcileOrphans(db);
    const after2 = { cp: stateOf(db, "cp"), cc: stateOf(db, "cc") };

    expect(after2).toEqual(after1);
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
