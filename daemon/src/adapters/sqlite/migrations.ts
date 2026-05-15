// Migration runner for SQLite. Scans migrations/*.sql lexicographically,
// tracks applied versions in schema_migrations, applies in a transaction.

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationFile {
  version: string;
  sql: string;
}

export const MIN_SQLITE_VERSION = "3.35.0";

const cmpSemver = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
};

export const assertSqliteVersion = (db: Database): void => {
  const row = db.query("SELECT sqlite_version() AS v").get() as { v: string };
  if (cmpSemver(row.v, MIN_SQLITE_VERSION) < 0) {
    throw new Error(
      `SQLite ${row.v} is below required minimum ${MIN_SQLITE_VERSION}. ` +
        `Migration 0007 uses ALTER TABLE DROP COLUMN (3.35.0+) and relies on ` +
        `legacy_alter_table=OFF default behavior (3.25.0+) for FK auto-rewrite.`,
    );
  }
};

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
  assertSqliteVersion(db);
  ensureSchemaTable(db);
  const applied = appliedVersions(db);
  const newlyApplied: string[] = [];
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    // Opt-in FK suspension: PRAGMA foreign_keys is a no-op mid-transaction,
    // so a migration that needs to rebuild a table referenced by FKs from
    // other tables (rename-rebuild-copy, SQLite docs §"Making Other Kinds
    // Of Table Schema Changes") must opt in via the marker
    // "-- void-os:fk-rebuild" on line 1. The runner toggles
    // foreign_keys=OFF outside the tx for those migrations only, runs a
    // foreign_key_check inside the tx to abort on dangling refs, and
    // restores foreign_keys=ON afterwards.
    const needsFkSuspend = /void-os:fk-rebuild/.test(m.sql);
    const fkRow = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    const fkWasOn = fkRow.foreign_keys === 1;
    if (needsFkSuspend && fkWasOn) db.exec("PRAGMA foreign_keys = OFF");
    try {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        if (needsFkSuspend && fkWasOn) {
          const dangling = db.query("PRAGMA foreign_key_check").all();
          if (dangling.length > 0) {
            throw new Error(
              `Migration ${m.version} left dangling FKs: ${JSON.stringify(dangling)}`,
            );
          }
        }
        insert.run(m.version, Date.now());
      });
      tx();
    } finally {
      if (needsFkSuspend && fkWasOn) db.exec("PRAGMA foreign_keys = ON");
    }
    newlyApplied.push(m.version);
  }
  return newlyApplied;
};

export const runMigrationsFromDir = (db: Database, dir: string): string[] => {
  const migrations = loadMigrations(dir);
  return applyMigrations(db, migrations);
};
