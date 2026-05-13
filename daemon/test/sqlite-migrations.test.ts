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
      expect(applied.map((r) => r.version)).toEqual(["0001_init"]);
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
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.version).toBe("0001_init");
      expect(row.applied_at).toBe(firstRow.applied_at);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
