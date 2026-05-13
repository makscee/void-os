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
  expect(e.length).toBeGreaterThan(0);
  expect(e[0]!.type).toBe('vault.append');
  expect(e[0]!.payload.sha_before).toBe(sha256Hex('old\n'));
  expect(e[0]!.payload.sha_after).toBe(sha256Hex('old\n\nnew\n'));
});

test('replace_section swaps body, preserves other sections + frontmatter', async () => {
  const src = '---\ntitle: t\n---\n\n## A\nold a\n\n## B\nold b\n';
  fs.writeFileSync(path.join(v.root, 'a.md'), src);
  await w.replace_section('a.md', 'A', 'new a body\n', CTX);
  expect(fs.readFileSync(path.join(v.root, 'a.md'), 'utf8'))
    .toBe('---\ntitle: t\n---\n\n## A\nnew a body\n\n## B\nold b\n');
});

test('replace_section last-section to EOF', async () => {
  const src = '## A\nx\n## B\nold\n';
  fs.writeFileSync(path.join(v.root, 'a.md'), src);
  await w.replace_section('a.md', 'B', 'new\n', CTX);
  expect(fs.readFileSync(path.join(v.root, 'a.md'), 'utf8'))
    .toBe('## A\nx\n## B\nnew\n');
});

test('replace_section SECTION_NOT_FOUND', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), '# T\n');
  await expect(w.replace_section('a.md', 'Missing', 'x', CTX)).rejects.toThrow('SECTION_NOT_FOUND');
});

test('set_property on file with existing FM', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), '---\ntitle: old\n---\n\nbody\n');
  await w.set_property('a.md', 'title', 'new', CTX);
  const out = fs.readFileSync(path.join(v.root, 'a.md'), 'utf8');
  expect(out).toMatch(/^---\n/);
  expect(out).toMatch(/title: new/);
  expect(out).toMatch(/\nbody\n/);
});

test('set_property creates FM when missing, preserves body', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'just body\n');
  await w.set_property('a.md', 'tags', ['x', 'y'], CTX);
  const out = fs.readFileSync(path.join(v.root, 'a.md'), 'utf8');
  expect(out).toMatch(/^---\n/);
  const { parseFm } = await import('../frontmatter');
  expect(parseFm(out).data.tags).toEqual(['x', 'y']);
  expect(parseFm(out).body.trimEnd()).toBe('just body');
});

test('set_property accepts non-string values without corruption', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'b\n');
  await w.set_property('a.md', 'count', 42, CTX);
  await w.set_property('a.md', 'enabled', true, CTX);
  const { parseFm } = await import('../frontmatter');
  const out = fs.readFileSync(path.join(v.root, 'a.md'), 'utf8');
  expect(parseFm(out).data.count).toBe(42);
  expect(parseFm(out).data.enabled).toBe(true);
});

test('patch replaces unique occurrence', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'foo bar baz\n');
  await w.patch('a.md', 'bar', 'BAR', CTX);
  expect(fs.readFileSync(path.join(v.root, 'a.md'), 'utf8')).toBe('foo BAR baz\n');
});

test('patch OLD_STRING_NOT_FOUND', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'x\n');
  await expect(w.patch('a.md', 'missing', 'y', CTX)).rejects.toThrow('OLD_STRING_NOT_FOUND');
});

test('patch OLD_STRING_NOT_UNIQUE', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'dup dup\n');
  await expect(w.patch('a.md', 'dup', 'X', CTX)).rejects.toThrow('OLD_STRING_NOT_UNIQUE');
});

test('delete removes file, emits vault.delete event', async () => {
  fs.writeFileSync(path.join(v.root, 'a.md'), 'bye\n');
  await w.delete('a.md', CTX);
  expect(fs.existsSync(path.join(v.root, 'a.md'))).toBe(false);
  const e = readEvents(v.db);
  expect(e.length).toBeGreaterThan(0);
  expect(e[0]!.type).toBe('vault.delete');
  expect(e[0]!.payload).toEqual({
    path: 'a.md',
    sha_before: sha256Hex('bye\n'),
    sha_after: null,
  });
});

test('delete ENOENT on missing file', async () => {
  await expect(w.delete('missing.md', CTX)).rejects.toThrow();
});
