import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createVaultWriter } from '..';
import { mkTmpVault, readEvents, CTX } from './_helpers';

let v: ReturnType<typeof mkTmpVault>;
beforeEach(() => { v = mkTmpVault(); });
afterEach(() => v.cleanup());

test('crashAfterTmpWrite: append throws, original intact, orphan in .void/tmp/, no event', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'original\n');
  const w = createVaultWriter({ vaultRoot: v.root, db: v.db, crashAfterTmpWrite: true });
  await expect(w.append('a.md', 'never persisted', null, CTX)).rejects.toThrow('SIMULATED_CRASH');
  expect(fs.readFileSync(path.join(v.root, 'a.md'), 'utf8')).toBe('original\n');
  // No orphan next to the target — must be in .void/tmp/ instead.
  expect(fs.readdirSync(v.root).filter(f => f.startsWith('a.md.'))).toEqual([]);
  const orphans = fs.readdirSync(path.join(v.root, '.void/tmp')).filter(f => f.startsWith('a.md.'));
  expect(orphans.length).toBe(1);
  expect(readEvents(v.db)).toEqual([]);  // no event recorded mid-crash
});

test('crashAfterTmpWrite: create throws, file does not exist, no event', async () => {
  const w = createVaultWriter({ vaultRoot: v.root, db: v.db, crashAfterTmpWrite: true });
  await expect(w.create('new.md', 'x', CTX)).rejects.toThrow('SIMULATED_CRASH');
  expect(fs.existsSync(path.join(v.root, 'new.md'))).toBe(false);
  expect(readEvents(v.db)).toEqual([]);
});
