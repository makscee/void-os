import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { Mutex } from './mutex';
import { resolveVaultPath } from './paths';
import { sha256Hex } from './sha';

export type WriteCtx = { agent: string; run_id: string };

export interface VaultWriter {
  read(p: string): Promise<{ content: string; sha: string }>;
}

export interface VaultWriterOpts {
  vaultRoot: string;
  db: Database;
  runId?: string;
  agent?: string;
  hooks?: { crashAfterTmpWrite?: boolean };
  // Legacy/flat form, kept for convenience:
  crashAfterTmpWrite?: boolean;
}

export function createVaultWriter(opts: VaultWriterOpts): VaultWriter {
  const vaultRootReal = fsSync.realpathSync(opts.vaultRoot);
  const tmpDir = path.join(vaultRootReal, '.void', 'tmp');
  fsSync.mkdirSync(tmpDir, { recursive: true });
  const mutex = new Mutex();
  const crashAfterTmpWrite = opts.hooks?.crashAfterTmpWrite ?? opts.crashAfterTmpWrite;

  function resolve(rel: string): string {
    return resolveVaultPath(rel, vaultRootReal);
  }

  async function read(p: string) {
    const abs = resolve(p);
    const content = await fs.readFile(abs, 'utf8');
    return { content, sha: sha256Hex(content) };
  }

  return { read } as VaultWriter;
}
