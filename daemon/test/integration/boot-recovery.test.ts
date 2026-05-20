// VOS-79 T10: boot recovery — flip orphan running/pending runs to interrupted
// and clear the per-Task current_run_id pointers atomically on daemon startup.
//
// VOS-168: `current_run_id` moved off `contexts` onto `tasks`. The recovery
// query now clears `tasks.current_run_id`; each seeded chat carries a root
// Task that holds the run pointer.
//
// Seeds an in-memory DB via the real migrations dir, then asserts bootRecovery
// only touches non-terminal runs and emits no WS events.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { bootRecovery } from "../../src/boot";

const MIGRATIONS_DIR = join(__dirname, "../../src/adapters/sqlite/migrations");

/** Insert a thin context + a root Task. The root Task carries `agent`;
 *  `current_run_id` is set afterwards by `pointAtRun` once the run row
 *  exists (FK ordering). */
function seedChat(db: Database, cid: string, now: number): void {
  db.run("INSERT INTO contexts (id, title, created_at) VALUES (?, ?, ?)", [
    cid,
    cid,
    now,
  ]);
  db.run(
    `INSERT INTO tasks (id, context_id, state, agent, last_event, created_at, updated_at)
       VALUES (?, ?, 'TASK_STATE_WORKING', 'maya', ?, ?, ?)`,
    [`t-${cid}`, cid, now, now, now],
  );
}

/** Point the root Task's current_run_id at an already-inserted run row. */
function pointAtRun(db: Database, cid: string, runId: string): void {
  db.run(
    "UPDATE tasks SET current_run_id = ? WHERE context_id = ? AND parent_task_id IS NULL",
    [runId, cid],
  );
}

/** Read the root Task's current_run_id for a context. */
function rootRun(db: Database, cid: string): string | null {
  const row = db
    .query(
      "SELECT current_run_id FROM tasks WHERE context_id = ? AND parent_task_id IS NULL",
    )
    .get(cid) as { current_run_id: string | null };
  return row.current_run_id;
}

function seeded(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);

  const now = Date.now();
  seedChat(db, "c1", now);
  // running, pending, done, error, cancelled — bootRecovery should only flip running+pending.
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES ('r-running', 'c1', 'maya', 'chat', 'running', ?)",
    [now],
  );
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES ('r-pending', 'c1', 'maya', 'chat', 'pending', ?)",
    [now],
  );
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, ended_at) VALUES ('r-done', 'c1', 'maya', 'chat', 'done', ?, ?)",
    [now, now],
  );
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, ended_at) VALUES ('r-error', 'c1', 'maya', 'chat', 'error', ?, ?)",
    [now, now],
  );
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, ended_at) VALUES ('r-cancelled', 'c1', 'maya', 'chat', 'cancelled', ?, ?)",
    [now, now],
  );
  pointAtRun(db, "c1", "r-running");
  return db;
}

test("bootRecovery flips pending+running to interrupted", () => {
  const db = seeded();
  bootRecovery(db);
  const rows = db
    .query("SELECT id, status FROM runs ORDER BY id")
    .all() as Array<{ id: string; status: string }>;
  expect(rows.find((r) => r.id === "r-running")!.status).toBe("interrupted");
  expect(rows.find((r) => r.id === "r-pending")!.status).toBe("interrupted");
  expect(rows.find((r) => r.id === "r-done")!.status).toBe("done");
  expect(rows.find((r) => r.id === "r-error")!.status).toBe("error");
  expect(rows.find((r) => r.id === "r-cancelled")!.status).toBe("cancelled");
});

test("bootRecovery clears tasks.current_run_id for interrupted runs", () => {
  const db = seeded();
  bootRecovery(db);
  expect(rootRun(db, "c1")).toBeNull();
});

test("bootRecovery emits nothing on WS (silent)", () => {
  const db = seeded();
  const events: Array<{ t: string; p: unknown }> = [];
  bootRecovery(db, (t, p) => events.push({ t, p }));
  expect(events).toEqual([]);
});

test("bootRecovery is a no-op when no orphans exist", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  const now = Date.now();
  seedChat(db, "c2", now);
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, ended_at) VALUES ('r-d', 'c2', 'maya', 'chat', 'done', ?, ?)",
    [now, now],
  );
  bootRecovery(db);
  const r = db.query("SELECT status FROM runs WHERE id = 'r-d'").get() as {
    status: string;
  };
  expect(r.status).toBe("done");
  expect(rootRun(db, "c2")).toBeNull();
});

test("bootRecovery flips multiple orphans across multiple chats", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  const now = Date.now();
  for (const cid of ["cA", "cB", "cC"]) {
    seedChat(db, cid, now);
    db.run(
      "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?, ?, 'maya', 'chat', 'running', ?)",
      [`r-${cid}`, cid, now],
    );
    pointAtRun(db, cid, `r-${cid}`);
  }
  bootRecovery(db);
  const rows = db.query("SELECT status FROM runs").all() as Array<{
    status: string;
  }>;
  for (const r of rows) expect(r.status).toBe("interrupted");
  const tasks = db
    .query("SELECT current_run_id FROM tasks")
    .all() as Array<{ current_run_id: string | null }>;
  for (const t of tasks) expect(t.current_run_id).toBeNull();
});
