import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { runMigrationsFromDir } from "../migrations";

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
