import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// VOS-83: events persistence was removed in migration 0007. The vault writer
// no longer records side-effects to SQLite — the empty fixture DB is kept
// only so writer construction still has a Database handle.

export interface TmpVault {
  root: string;
  db: Database;
  cleanup: () => void;
}

export function mkTmpVault(): TmpVault {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const db = new Database(':memory:');
  return {
    root,
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Legacy helper retained for tests that still assert "no events" — always []
// post-VOS-83.
export function readEvents(_db: Database): Array<{ type: string; agent: string; run_id: string; payload: unknown }> {
  return [];
}

export const CTX = { agent: 'test', run_id: 'r-test' };
