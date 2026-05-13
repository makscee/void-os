// SQLite adapter. Owns state.sqlite connection. T3 owns migration runner.

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
