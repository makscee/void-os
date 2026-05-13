import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mirrors the relevant columns of 0001_init.sql events table.
// Column is `data` (NOT `payload`) per migration.
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  chat_id TEXT,
  run_id TEXT,
  agent TEXT,
  type TEXT NOT NULL,
  data TEXT
);
`;

export interface TmpVault {
  root: string;
  db: Database;
  cleanup: () => void;
}

export function mkTmpVault(): TmpVault {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return {
    root,
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function readEvents(db: Database): Array<{ type: string; agent: string; run_id: string; payload: any }> {
  return db.prepare('SELECT type, agent, run_id, data FROM events ORDER BY id')
    .all()
    .map((r: any) => ({ type: r.type, agent: r.agent, run_id: r.run_id, payload: JSON.parse(r.data) }));
}

export const CTX = { agent: 'test', run_id: 'r-test' };
