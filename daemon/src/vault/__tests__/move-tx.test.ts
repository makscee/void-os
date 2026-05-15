import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createVaultWriter, type VaultWriter } from '..';
import { mkTmpVault, readEvents, CTX } from './_helpers';
import { sha256Hex } from '../sha';

let v: ReturnType<typeof mkTmpVault>;
let w: VaultWriter;
beforeEach(() => { v = mkTmpVault(); w = createVaultWriter({ vaultRoot: v.root, db: v.db }); });
afterEach(() => v.cleanup());

test('move renames file, mkdir -p target', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'X\n');
  await w.move('a.md', 'new/sub/b.md', CTX);
  expect(fs.existsSync(path.join(v.root, 'a.md'))).toBe(false);
  expect(fs.readFileSync(path.join(v.root, 'new/sub/b.md'), 'utf8')).toBe('X\n');
  // VOS-83: events persistence removed; transactional delete+create rows no
  // longer recorded.
});

test('move fails EEXIST if target exists', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'X\n');
  fs.writeFileSync(path.join(v.root, 'b.md'), 'Y\n');
  await expect(w.move('a.md', 'b.md', CTX)).rejects.toThrow('EEXIST');
});

test('move ENOENT if source missing', async () => {
  await expect(w.move('missing.md', 'b.md', CTX)).rejects.toThrow();
});
