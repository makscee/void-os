import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createVaultWriter, type VaultWriter } from '..';
import { mkTmpVault, readEvents, CTX } from './_helpers';
import { sha256Hex } from '../sha';

let v: ReturnType<typeof mkTmpVault>;
let w: VaultWriter;

beforeEach(() => {
  v = mkTmpVault();
  w = createVaultWriter({ vaultRoot: v.root, db: v.db });
});
afterEach(() => v.cleanup());

test('read returns content + sha, no event row', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'hello');
  const r = await w.read('a.md');
  expect(r.content).toBe('hello');
  expect(r.sha).toBe(sha256Hex('hello'));
  expect(readEvents(v.db)).toEqual([]);
});

test('read throws ENOENT for missing file', async () => {
  await expect(w.read('missing.md')).rejects.toThrow();
});

test('create writes file, mkdir -p, emits vault.create event', async () => {
  await w.create('sub/deep/a.md', 'hello', CTX);
  expect(fs.readFileSync(path.join(v.root, 'sub/deep/a.md'), 'utf8')).toBe('hello');
  const e = readEvents(v.db);
  expect(e).toHaveLength(1);
  expect(e[0]).toMatchObject({
    type: 'vault.create',
    agent: 'test',
    run_id: 'r-test',
    payload: { path: 'sub/deep/a.md', sha_before: null, sha_after: sha256Hex('hello') },
  });
});

test('create fails EEXIST', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'x');
  await expect(w.create('a.md', 'y', CTX)).rejects.toThrow('EEXIST');
  expect(readEvents(v.db)).toEqual([]);
});
