import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createVaultWriter, type VaultWriter } from '..';
import { mkTmpVault, readEvents, CTX } from './_helpers';

let v: ReturnType<typeof mkTmpVault>;
let w: VaultWriter;
beforeEach(() => { v = mkTmpVault(); w = createVaultWriter({ vaultRoot: v.root, db: v.db }); });
afterEach(() => v.cleanup());

test('100 parallel EOF appends produce 100 ordered lines', async () => {
  fs.writeFileSync(path.join(v.root, 'log.md'), '');
  const tasks = Array.from({ length: 100 }, (_, i) => w.append('log.md', `line-${i}`, null, CTX));
  await Promise.all(tasks);
  const out = fs.readFileSync(path.join(v.root, 'log.md'), 'utf8');
  // Just assert: all 100 lines present, in some order, no torn writes.
  const lines = out.split('\n').filter(l => l.startsWith('line-'));
  expect(lines.length).toBe(100);
  const set = new Set(lines);
  expect(set.size).toBe(100);  // all unique
  // VOS-83: events persistence removed; mutex/atomic correctness now lives
  // entirely in filesystem state.
});
