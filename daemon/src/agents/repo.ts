// VOS-92 T1.5: AgentRepo over the existing `agents` table
// (daemon/src/adapters/sqlite/migrations/0001_init.sql:66).

import type { Database } from "bun:sqlite";
import type { AgentRow } from "./types";

export interface AgentRepo {
  upsertAll(rows: AgentRow[]): void;
  list(): AgentRow[];
}

export function makeAgentRepo(db: Database): AgentRepo {
  const upsertStmt = db.prepare(
    `INSERT INTO agents (name, description, model, vault_path, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       model       = excluded.model,
       vault_path  = excluded.vault_path,
       updated_at  = excluded.updated_at`,
  );
  const selectStmt = db.prepare(
    "SELECT name, description, model, vault_path, updated_at FROM agents",
  );

  return {
    upsertAll(rows) {
      if (rows.length === 0) return;
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
      return selectStmt.all() as AgentRow[];
    },
  };
}
