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

test('append no-section appends at EOF with one blank line separator', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), '# T\n\nbody\n');
  await w.append('a.md', '- item', null, CTX);
  expect(fs.readFileSync(path.join(v.root, 'a.md'), 'utf8')).toBe('# T\n\nbody\n\n- item\n');
});

test('append with section inserts before next ##', async () => {
  const src = '# T\n\n## Log\n- one\n\n## Next\nx\n';
  fs.writeFileSync(path.join(v.root, 'a.md'), src);
  await w.append('a.md', '- two', 'Log', CTX);
  expect(fs.readFileSync(path.join(v.root, 'a.md'), 'utf8'))
    .toBe('# T\n\n## Log\n- one\n\n- two\n\n## Next\nx\n');
});

test('append with section at EOF', async () => {
  const src = '# T\n\n## Log\n- one\n';
  fs.writeFileSync(path.join(v.root, 'a.md'), src);
  await w.append('a.md', '- two', 'Log', CTX);
  expect(fs.readFileSync(path.join(v.root, 'a.md'), 'utf8'))
    .toBe('# T\n\n## Log\n- one\n\n- two\n');
});

test('append SECTION_NOT_FOUND', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), '# T\n');
  await expect(w.append('a.md', 'x', 'Missing', CTX)).rejects.toThrow('SECTION_NOT_FOUND');
});

test('append emits vault.append event with sha_before/after', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'old\n');
  await w.append('a.md', 'new', null, CTX);
  const e = readEvents(v.db);
  expect(e[0].type).toBe('vault.append');
  expect(e[0].payload.sha_before).toBe(sha256Hex('old\n'));
  expect(e[0].payload.sha_after).toBe(sha256Hex('old\n\nnew\n'));
});
