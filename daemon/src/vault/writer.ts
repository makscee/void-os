import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { Mutex } from './mutex';
import { resolveVaultPath } from './paths';
import { sha256Hex } from './sha';
import { atomicWrite } from './atomic';
import { recordVaultEvent } from './events';
import { findSection } from './sections';
import { parseFm, stringifyFm } from './frontmatter';

export type WriteCtx = { agent: string; run_id: string };

export interface VaultWriter {
  read(p: string): Promise<{ content: string; sha: string }>;
  create(p: string, content: string, ctx: WriteCtx): Promise<void>;
  append(p: string, content: string, section: string | null, ctx: WriteCtx): Promise<void>;
  replace_section(p: string, section: string, content: string, ctx: WriteCtx): Promise<void>;
  set_property(p: string, key: string, value: unknown, ctx: WriteCtx): Promise<void>;
  patch(p: string, old_string: string, new_string: string, ctx: WriteCtx): Promise<void>;
  delete(p: string, ctx: WriteCtx): Promise<void>;
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

  function buildAppended(oldContent: string, addition: string, section: string | null): string {
    const payload = addition.replace(/\s+$/, '') + '\n';
    if (section === null) {
      const pre = oldContent.endsWith('\n') ? oldContent : oldContent + '\n';
      return pre + '\n' + payload;
    }
    const r = findSection(oldContent, section);
    if (!r) {
      const err: any = new Error('SECTION_NOT_FOUND');
      err.code = 'SECTION_NOT_FOUND';
      throw err;
    }
    const body = oldContent.slice(r.bodyStart, r.bodyEnd);
    const trimmedBody = body.replace(/\s+$/, '');
    const reconstructed = trimmedBody.length > 0 ? trimmedBody + '\n' : '';
    const pre = oldContent.slice(0, r.bodyStart) + reconstructed;
    const post = oldContent.slice(r.bodyEnd);
    const sep = reconstructed.length > 0 ? '\n' : '';
    // If post starts with a `## ` heading, separate appended payload from it with a blank line.
    const trailingSep = post.length > 0 ? '\n' : '';
    return pre + sep + payload + trailingSep + post;
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

  async function append(p: string, content: string, section: string | null, ctx: WriteCtx) {
    const abs = resolve(p);
    await mutex.runExclusive(abs, async () => {
      const oldContent = await fs.readFile(abs, 'utf8');
      const newContent = buildAppended(oldContent, content, section);
      await atomicWrite(abs, newContent, tmpDir, { crashAfterTmpWrite });
      recordVaultEvent(opts.db, {
        type: 'vault.append',
        agent: ctx.agent,
        run_id: ctx.run_id,
        path: p,
        sha_before: sha256Hex(oldContent),
        sha_after: sha256Hex(newContent),
      });
    });
  }

  async function replace_section(p: string, section: string, content: string, ctx: WriteCtx) {
    const abs = resolve(p);
    await mutex.runExclusive(abs, async () => {
      const oldContent = await fs.readFile(abs, 'utf8');
      const r = findSection(oldContent, section);
      if (!r) {
        const e: any = new Error('SECTION_NOT_FOUND');
        e.code = 'SECTION_NOT_FOUND';
        throw e;
      }
      const normalized = content.endsWith('\n') ? content : content + '\n';
      const pre = oldContent.slice(0, r.bodyStart);
      const post = oldContent.slice(r.bodyEnd);
      const sep = post.length > 0 && !normalized.endsWith('\n\n') ? '\n' : '';
      const newContent = pre + normalized + sep + post;
      await atomicWrite(abs, newContent, tmpDir, { crashAfterTmpWrite });
      recordVaultEvent(opts.db, {
        type: 'vault.replace_section',
        agent: ctx.agent,
        run_id: ctx.run_id,
        path: p,
        sha_before: sha256Hex(oldContent),
        sha_after: sha256Hex(newContent),
      });
    });
  }

  async function set_property(p: string, key: string, value: unknown, ctx: WriteCtx) {
    const abs = resolve(p);
    await mutex.runExclusive(abs, async () => {
      const oldContent = await fs.readFile(abs, 'utf8');
      const { data, body } = parseFm(oldContent);
      data[key] = value;
      const newContent = stringifyFm(data, body);
      await atomicWrite(abs, newContent, tmpDir, { crashAfterTmpWrite });
      recordVaultEvent(opts.db, {
        type: 'vault.set_property',
        agent: ctx.agent,
        run_id: ctx.run_id,
        path: p,
        sha_before: sha256Hex(oldContent),
        sha_after: sha256Hex(newContent),
      });
    });
  }

  async function patch(p: string, old_string: string, new_string: string, ctx: WriteCtx) {
    const abs = resolve(p);
    await mutex.runExclusive(abs, async () => {
      const oldContent = await fs.readFile(abs, 'utf8');
      const first = oldContent.indexOf(old_string);
      if (first === -1) {
        const e: any = new Error('OLD_STRING_NOT_FOUND');
        e.code = 'OLD_STRING_NOT_FOUND';
        throw e;
      }
      const second = oldContent.indexOf(old_string, first + old_string.length);
      if (second !== -1) {
        const e: any = new Error('OLD_STRING_NOT_UNIQUE');
        e.code = 'OLD_STRING_NOT_UNIQUE';
        throw e;
      }
      const newContent = oldContent.slice(0, first) + new_string + oldContent.slice(first + old_string.length);
      await atomicWrite(abs, newContent, tmpDir, { crashAfterTmpWrite });
      recordVaultEvent(opts.db, {
        type: 'vault.patch',
        agent: ctx.agent,
        run_id: ctx.run_id,
        path: p,
        sha_before: sha256Hex(oldContent),
        sha_after: sha256Hex(newContent),
      });
    });
  }

  async function deleteOp(p: string, ctx: WriteCtx) {
    const abs = resolve(p);
    await mutex.runExclusive(abs, async () => {
      const oldContent = await fs.readFile(abs, 'utf8'); // throws ENOENT if missing
      await fs.unlink(abs);
      recordVaultEvent(opts.db, {
        type: 'vault.delete',
        agent: ctx.agent,
        run_id: ctx.run_id,
        path: p,
        sha_before: sha256Hex(oldContent),
        sha_after: null,
      });
    });
  }

  return { read, create, append, replace_section, set_property, patch, delete: deleteOp } as VaultWriter;
}
