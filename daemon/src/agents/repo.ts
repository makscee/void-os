// VOS-92 T1.5: AgentRepo over the existing `agents` table
// (daemon/src/adapters/sqlite/migrations/0001_init.sql:66).

import type { Database } from "bun:sqlite";
import type { AgentRow } from "./types";

export interface AgentRepo {
  upsertAll(rows: AgentRow[]): void;
  list(): AgentRow[];
}

// Statements are prepared lazily inside each method body so that constructing
// the repo against a DB that has not yet run migrations does not throw. The
// `agents` table only needs to exist by the time `upsertAll` / `list` is
// actually called. prepare() cost per call is negligible at this scale.
const UPSERT_SQL = `INSERT INTO agents (name, description, model, vault_path, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       model       = excluded.model,
       vault_path  = excluded.vault_path,
       updated_at  = excluded.updated_at`;
const SELECT_SQL =
  "SELECT name, description, model, vault_path, updated_at FROM agents";

export function makeAgentRepo(db: Database): AgentRepo {
  return {
    upsertAll(rows) {
      if (rows.length === 0) return;
      const upsertStmt = db.prepare(UPSERT_SQL);
      const tx = db.transaction((batch: AgentRow[]) => {
        for (const r of batch) {
          // Guard: SQLite's `TEXT PRIMARY KEY` does NOT implicitly forbid NULL
          // (unlike INTEGER PRIMARY KEY). Explicit check keeps the transaction
          // contract — a bad row aborts the batch and rolls back prior inserts.
          if (r.name == null || r.name === "") {
            throw new Error("AgentRow.name must be a non-empty string");
          }
          upsertStmt.run(r.name, r.description, r.model, r.vault_path, r.updated_at);
        }
      });
      tx(rows);
    },
    list() {
      return db.prepare(SELECT_SQL).all() as AgentRow[];
    },
  };
}
