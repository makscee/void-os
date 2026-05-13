import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

function applyMigrations(db: Database, files: string[]): void {
  for (const f of files) {
    db.run(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
}

test("migration 0003 adds session_id, current_run_id columns to chats", () => {
  const db = new Database(":memory:");
  applyMigrations(db, [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
  ]);

  const cols = db.query("PRAGMA table_info(chats)").all() as Array<{
    name: string;
  }>;
  const names = cols.map((c) => c.name);
  expect(names).toContain("session_id");
  expect(names).toContain("current_run_id");
});

test("migration 0003 creates chats_updated_at_idx and chats_session_id_idx", () => {
  const db = new Database(":memory:");
  applyMigrations(db, [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
  ]);

  const idxs = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chats'",
    )
    .all() as Array<{ name: string }>;
  const idxNames = idxs.map((i) => i.name);
  expect(idxNames).toContain("chats_updated_at_idx");
  expect(idxNames).toContain("chats_session_id_idx");
});

test("migration 0003 is idempotent on re-run via IF NOT EXISTS guards", () => {
  const db = new Database(":memory:");
  applyMigrations(db, [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
  ]);

  // Re-running the index creates should be safe (ALTER TABLE ADD COLUMN
  // cannot use IF NOT EXISTS in sqlite, so we only verify the index half
  // here; the runner's schema_migrations guard prevents the ALTERs from
  // re-running in production).
  const sql = readFileSync(
    join(MIGRATIONS_DIR, "0003_chat_lifecycle.sql"),
    "utf8",
  );
  const indexOnly = sql
    .split("\n")
    .filter((line) => !line.trim().toUpperCase().startsWith("ALTER"))
    .join("\n");
  expect(() => db.run(indexOnly)).not.toThrow();
});
