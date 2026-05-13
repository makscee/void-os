import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWrite } from '../atomic';

let root: string;
let tmpDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  tmpDir = path.join(root, '.void/tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('writes new file', async () => {
  const p = path.join(root, 'a.md');
  await atomicWrite(p, 'hello', tmpDir);
  expect(fs.readFileSync(p, 'utf8')).toBe('hello');
});

test('overwrites existing file atomically; tmpDir is clean after', async () => {
  const p = path.join(root, 'a.md');
  fs.writeFileSync(p, 'old');
  await atomicWrite(p, 'new', tmpDir);
  expect(fs.readFileSync(p, 'utf8')).toBe('new');
  expect(fs.readdirSync(tmpDir)).toEqual([]);
});

test('crashAfterTmpWrite throws, original intact, orphan in tmpDir, target dir untouched', async () => {
  const p = path.join(root, 'a.md');
  fs.writeFileSync(p, 'original');
  await expect(atomicWrite(p, 'replacement', tmpDir, { crashAfterTmpWrite: true })).rejects.toThrow('SIMULATED_CRASH');
  expect(fs.readFileSync(p, 'utf8')).toBe('original');
  // orphan lands in .void/tmp/, NOT next to the target
  expect(fs.readdirSync(root).filter(f => f.startsWith('a.md.'))).toEqual([]);
  const orphans = fs.readdirSync(tmpDir).filter(f => f.startsWith('a.md.'));
  expect(orphans.length).toBe(1);
  expect(fs.readFileSync(path.join(tmpDir, orphans[0]!), 'utf8')).toBe('replacement');
});
