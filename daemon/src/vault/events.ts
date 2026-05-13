import type { Database } from 'bun:sqlite';

export interface VaultEventRow {
  type: string;            // 'vault.append' etc.
  agent: string;
  run_id: string;
  path: string;            // vault-relative
  sha_before: string | null;
  sha_after: string | null;
}

export function recordVaultEvent(db: Database, row: VaultEventRow): void {
  db.prepare(
    `INSERT INTO events (ts, chat_id, run_id, agent, type, data)
     VALUES (unixepoch('subsec'), NULL, ?, ?, ?, ?)`
  ).run(row.run_id, row.agent, row.type,
    JSON.stringify({ path: row.path, sha_before: row.sha_before, sha_after: row.sha_after }));
}

export function recordMovePair(
  db: Database,
  ctx: { agent: string; run_id: string },
  from: string,
  to: string,
  shaContent: string,
): void {
  db.transaction(() => {
    recordVaultEvent(db, {
      type: 'vault.delete', agent: ctx.agent, run_id: ctx.run_id,
      path: from, sha_before: shaContent, sha_after: null,
    });
    recordVaultEvent(db, {
      type: 'vault.create', agent: ctx.agent, run_id: ctx.run_id,
      path: to, sha_before: null, sha_after: shaContent,
    });
  })();
}
