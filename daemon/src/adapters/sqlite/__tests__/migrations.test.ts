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
