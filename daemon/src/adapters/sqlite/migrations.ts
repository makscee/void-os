// Migration runner for SQLite. Scans migrations/*.sql lexicographically,
// tracks applied versions in schema_migrations, applies in a transaction.

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationFile {
  version: string;
  sql: string;
}

const ensureSchemaTable = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
};

export const loadMigrations = (dir: string): MigrationFile[] => {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => ({
    version: f.replace(/\.sql$/, ""),
    sql: readFileSync(join(dir, f), "utf8"),
  }));
};

export const appliedVersions = (db: Database): Set<string> => {
  ensureSchemaTable(db);
  const rows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: string }>;
  return new Set(rows.map((r) => r.version));
};

export const applyMigrations = (db: Database, migrations: MigrationFile[]): string[] => {
  ensureSchemaTable(db);
  const applied = appliedVersions(db);
  const newlyApplied: string[] = [];
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, Date.now());
    });
    tx();
    newlyApplied.push(m.version);
  }
  return newlyApplied;
};

export const runMigrationsFromDir = (db: Database, dir: string): string[] => {
  const migrations = loadMigrations(dir);
  return applyMigrations(db, migrations);
};
