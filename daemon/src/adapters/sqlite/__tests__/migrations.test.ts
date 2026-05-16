import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import {
  runMigrationsFromDir,
  MIN_SQLITE_VERSION,
  assertSqliteVersion,
} from "../migrations";

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

describe("runMigrationsFromDir", () => {
  it("applies all migrations and costs table has cache token columns", () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS_DIR);

    const columns: { name: string }[] = db
      .query("PRAGMA table_info(costs)")
      .all() as { name: string }[];

    const names = columns.map((c) => c.name);
    expect(names).toContain("cache_create_tokens");
    expect(names).toContain("cache_read_tokens");
  });

  it("0012 adds task_id + provider to costs", () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS_DIR);

    const cols = db.query("PRAGMA table_info(costs)").all() as Array<{
      name: string;
      type: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.task_id).toBeDefined();
    expect(byName.task_id!.notnull).toBe(0);
    expect(byName.provider).toBeDefined();
    expect(byName.provider!.notnull).toBe(1);
    expect(byName.provider!.dflt_value).toBe("'claude-code'");

    const indexes = db.query("PRAGMA index_list(costs)").all() as Array<{
      name: string;
    }>;
    expect(indexes.map((i) => i.name)).toContain("idx_costs_task");

    // FK target check
    const fks = db.query("PRAGMA foreign_key_list(costs)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const taskFk = fks.find((f) => f.from === "task_id");
    expect(taskFk).toBeDefined();
    expect(taskFk!.table).toBe("tasks");
    expect(taskFk!.on_delete).toBe("SET NULL");
  });
});

describe("SQLite version assertion", () => {
  it("exposes minimum required version constant", () => {
    expect(MIN_SQLITE_VERSION).toBe("3.35.0");
  });

  it("passes assertion on current Bun SQLite (>= 3.35.0)", () => {
    const db = new Database(":memory:");
    expect(() => assertSqliteVersion(db)).not.toThrow();
  });

  it("rejects too-old version (simulated)", () => {
    const fakeDb = {
      query: () => ({ get: () => ({ v: "3.34.0" }) }),
    } as unknown as Database;
    expect(() => assertSqliteVersion(fakeDb)).toThrow(/SQLite/);
  });
});
