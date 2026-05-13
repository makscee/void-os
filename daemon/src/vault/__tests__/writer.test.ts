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
