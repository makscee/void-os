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
// VOS-153: extended with optional color/avatar/tagline columns (migration
// 0015_agents_rich_fields). Older AgentRow values without these fields
// upsert NULL into the new columns; older DB rows that pre-date the
// migration also surface as undefined here (SQLite returns null →
// JavaScript null, which we normalize to undefined at the row boundary).
const UPSERT_SQL = `INSERT INTO agents (name, description, model, vault_path, updated_at, color, avatar, tagline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       model       = excluded.model,
       vault_path  = excluded.vault_path,
       updated_at  = excluded.updated_at,
       color       = excluded.color,
       avatar      = excluded.avatar,
       tagline     = excluded.tagline`;
const SELECT_SQL =
  "SELECT name, description, model, vault_path, updated_at, color, avatar, tagline FROM agents";

type AgentRowRaw = Omit<AgentRow, "color" | "avatar" | "tagline"> & {
  color: string | null;
  avatar: string | null;
  tagline: string | null;
};

function normalizeRow(raw: AgentRowRaw): AgentRow {
  const row: AgentRow = {
    name: raw.name,
    description: raw.description,
    model: raw.model,
    vault_path: raw.vault_path,
    updated_at: raw.updated_at,
  };
  if (raw.color != null) row.color = raw.color;
  if (raw.avatar != null) row.avatar = raw.avatar;
  if (raw.tagline != null) row.tagline = raw.tagline;
  return row;
}

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
          upsertStmt.run(
            r.name,
            r.description,
            r.model,
            r.vault_path,
            r.updated_at,
            r.color ?? null,
            r.avatar ?? null,
            r.tagline ?? null,
          );
        }
      });
      tx(rows);
    },
    list() {
      const raws = db.prepare(SELECT_SQL).all() as AgentRowRaw[];
      return raws.map(normalizeRow);
    },
  };
}
