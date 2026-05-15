import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/adapters/sqlite/index.js";

// Post-0007 schema: events/agents dropped, chats renamed to contexts,
// tasks/artifacts/agent_cards added.
const EXPECTED_TABLES = [
  "contexts",
  "runs",
  "costs",
  "schedules",
  "connected_folders",
  "messages",
  "tasks",
  "artifacts",
  "agent_cards",
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

// Migrations the floor tests require to be applied. Newer migrations are
// allowed (and expected) — assertions check "contains these" not "equals".
const REQUIRED_MIGRATIONS = [
  "0001_init",
  "0002_runs_columns",
  "0003_chat_lifecycle",
  "0004_messages",
  "0005_costs_cache",
  "0006_costs_chat_id",
  "0007_a2a_tables",
];

describe("sqlite migrations", () => {
  test("applies 0001_init and creates all 8 tables + schema_migrations", () => {
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
      const appliedVersions = applied.map((r) => r.version);
      for (const v of REQUIRED_MIGRATIONS) {
        expect(appliedVersions).toContain(v);
      }
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

      // schema_migrations contains all required migrations.
      const applied = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: string }>;
      const appliedVersions = applied.map((r) => r.version);
      for (const v of REQUIRED_MIGRATIONS) {
        expect(appliedVersions).toContain(v);
      }

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
      const firstCount = (
        db1
          .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
          .get() as { n: number }
      ).n;
      db1.close();

      const db2 = openDatabase(dbPath);
      const rows = db2
        .prepare("SELECT version, applied_at FROM schema_migrations")
        .all() as Array<{ version: string; applied_at: number }>;
      // Idempotency: re-opening must not add rows or re-apply 0001_init.
      expect(rows).toHaveLength(firstCount);
      expect(firstCount).toBeGreaterThanOrEqual(REQUIRED_MIGRATIONS.length);
      const row = rows.find((r) => r.version === "0001_init")!;
      expect(row.version).toBe("0001_init");
      expect(row.applied_at).toBe(firstRow.applied_at);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
