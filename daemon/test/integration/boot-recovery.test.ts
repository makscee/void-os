// VOS-79 T10: boot recovery — flip orphan running/pending runs to interrupted
// and clear chats.current_run_id pointers atomically on daemon startup.
//
// Seeds an in-memory DB via the real migrations dir, then asserts bootRecovery
// only touches non-terminal runs and emits no WS events.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { bootRecovery } from "../../src/boot";

const MIGRATIONS_DIR = join(__dirname, "../../src/adapters/sqlite/migrations");

function seeded(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);

  const now = Date.now();
  db.run(
    "INSERT INTO chats (id, title, agent, created_at, updated_at) VALUES ('c1', 'c1', 'maya', ?, ?)",
    [now, now],
  );
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
  db.run("UPDATE chats SET current_run_id = 'r-running' WHERE id = 'c1'");
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

test("bootRecovery clears chats.current_run_id for interrupted runs", () => {
  const db = seeded();
  bootRecovery(db);
  const c = db
    .query("SELECT current_run_id FROM chats WHERE id = 'c1'")
    .get() as { current_run_id: string | null };
  expect(c.current_run_id).toBeNull();
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
  db.run(
    "INSERT INTO chats (id, title, agent, created_at, updated_at) VALUES ('c2', 'c2', 'maya', ?, ?)",
    [now, now],
  );
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, ended_at) VALUES ('r-d', 'c2', 'maya', 'chat', 'done', ?, ?)",
    [now, now],
  );
  bootRecovery(db);
  const r = db.query("SELECT status FROM runs WHERE id = 'r-d'").get() as { status: string };
  expect(r.status).toBe("done");
  const c = db
    .query("SELECT current_run_id FROM chats WHERE id = 'c2'")
    .get() as { current_run_id: string | null };
  expect(c.current_run_id).toBeNull();
});

test("bootRecovery flips multiple orphans across multiple chats", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  const now = Date.now();
  for (const cid of ["cA", "cB", "cC"]) {
    db.run(
      "INSERT INTO chats (id, title, agent, created_at, updated_at) VALUES (?, ?, 'maya', ?, ?)",
      [cid, cid, now, now],
    );
    db.run(
      "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?, ?, 'maya', 'chat', 'running', ?)",
      [`r-${cid}`, cid, now],
    );
    db.run("UPDATE chats SET current_run_id = ? WHERE id = ?", [`r-${cid}`, cid]);
  }
  bootRecovery(db);
  const rows = db.query("SELECT status FROM runs").all() as Array<{ status: string }>;
  for (const r of rows) expect(r.status).toBe("interrupted");
  const chats = db
    .query("SELECT current_run_id FROM chats")
    .all() as Array<{ current_run_id: string | null }>;
  for (const c of chats) expect(c.current_run_id).toBeNull();
});
