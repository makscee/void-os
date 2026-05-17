// SQLite adapter. Owns state.sqlite connection. T3 owns migration runner.
//
// NOTE: task brief named `better-sqlite3@11.10.0`, but `better-sqlite3` is a
// native Node binding that Bun cannot load (see oven-sh/bun#4290). We use
// `bun:sqlite` instead — same synchronous API surface (Database, prepare,
// exec, pragma, transaction). Logged in T3 report as a deviation.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMigrationsFromDir } from "./migrations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const MIGRATIONS_DIR = join(__dirname, "migrations");

export interface OpenDatabaseOptions {
  migrationsDir?: string;
}

export const openDatabase = (path: string, opts: OpenDatabaseOptions = {}): Database => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, opts.migrationsDir ?? MIGRATIONS_DIR);
  return db;
};

export type { Database };

// Legacy interface kept for callers wired in T2. Implementations land in T4+.
export interface Migration {
  id: string;
  up: string;
}

export interface MigrationRunner {
  run(migrations: Migration[]): Promise<void>;
  applied(): Promise<string[]>;
}

export interface SqliteAdapter {
  open(path: string): Promise<void>;
  close(): Promise<void>;
  exec(sql: string): void;
  query<T = unknown>(sql: string, params?: unknown[]): T[];
  migrations(): MigrationRunner;
}

export const createSqliteAdapter = (): SqliteAdapter => {
  throw new Error("not implemented");
};
