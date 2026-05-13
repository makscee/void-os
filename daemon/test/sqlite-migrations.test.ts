import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/adapters/sqlite/index.js";

const EXPECTED_TABLES = [
  "events",
  "chats",
  "runs",
  "costs",
  "agents",
  "schedules",
  "connected_folders",
  "schema_migrations",
];

const listTables = (db: ReturnType<typeof openDatabase>): string[] => {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
};

describe("sqlite migrations", () => {
  test("applies 0001_init and creates all 7 tables + schema_migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "void-os-sqlite-"));
    const dbPath = join(dir, "state.sqlite");
    try {
      const db = openDatabase(dbPath);
      const tables = listTables(db);
      for (const name of EXPECTED_TABLES) {
        expect(tables).toContain(name);
      }
      const applied = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: string }>;
      expect(applied.map((r) => r.version)).toEqual(["0001_init", "0002_runs_columns"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("0002 adds session_id/exit_code/kill_reason columns and idx_runs_session", () => {
    const dir = mkdtempSync(join(tmpdir(), "void-os-sqlite-"));
    const dbPath = join(dir, "state.sqlite");
    try {
      const db = openDatabase(dbPath);

      // schema_migrations contains both migrations.
      const applied = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: string }>;
      expect(applied.map((r) => r.version)).toEqual(["0001_init", "0002_runs_columns"]);

      // runs has the new columns.
      const cols = db
        .prepare("PRAGMA table_info(runs)")
        .all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("session_id");
      expect(colNames).toContain("exit_code");
      expect(colNames).toContain("kill_reason");

      // idx_runs_session exists.
      const idx = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'")
        .all() as Array<{ name: string }>;
      expect(idx.map((r) => r.name)).toContain("idx_runs_session");

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-opening the database does not re-apply migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "void-os-sqlite-"));
    const dbPath = join(dir, "state.sqlite");
    try {
      const db1 = openDatabase(dbPath);
      const firstRow = db1
        .prepare("SELECT applied_at FROM schema_migrations WHERE version='0001_init'")
        .get() as { applied_at: number };
      db1.close();

      const db2 = openDatabase(dbPath);
      const rows = db2
        .prepare("SELECT version, applied_at FROM schema_migrations")
        .all() as Array<{ version: string; applied_at: number }>;
      expect(rows).toHaveLength(2);
      const row = rows.find((r) => r.version === "0001_init")!;
      expect(row.version).toBe("0001_init");
      expect(row.applied_at).toBe(firstRow.applied_at);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
