import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { Mutex } from './mutex';
import { resolveVaultPath } from './paths';
import { sha256Hex } from './sha';
import { atomicWrite } from './atomic';
import { recordVaultEvent } from './events';

export type WriteCtx = { agent: string; run_id: string };

export interface VaultWriter {
  read(p: string): Promise<{ content: string; sha: string }>;
  create(p: string, content: string, ctx: WriteCtx): Promise<void>;
}

export interface VaultWriterOpts {
  vaultRoot: string;
  db: Database;
  runId?: string;
  agent?: string;
  hooks?: { crashAfterTmpWrite?: boolean };
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

  async function create(p: string, content: string, ctx: WriteCtx) {
    const abs = resolve(p);
    await mutex.runExclusive(abs, async () => {
      if (fsSync.existsSync(abs)) {
        const err: any = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, content, tmpDir, { crashAfterTmpWrite });
      recordVaultEvent(opts.db, {
        type: 'vault.create',
        agent: ctx.agent,
        run_id: ctx.run_id,
        path: p,
        sha_before: null,
        sha_after: sha256Hex(content),
      });
    });
  }

  return { read, create } as VaultWriter;
}
