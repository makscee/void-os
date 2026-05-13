import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveVaultPath, ERR } from '../paths';

let root: string;
let rootReal: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-paths-'));
  rootReal = fs.realpathSync(root);
  fs.mkdirSync(path.join(root, 'a/b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a/b/file.md'), 'x');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('resolves existing file', () => {
  expect(resolveVaultPath('a/b/file.md', rootReal)).toBe(path.join(rootReal, 'a/b/file.md'));
});

test('resolves non-existent file via ancestor walk', () => {
  expect(resolveVaultPath('a/b/new/deep/file.md', rootReal)).toBe(path.join(rootReal, 'a/b/new/deep/file.md'));
});

test('rejects absolute path', () => {
  expect(() => resolveVaultPath('/etc/passwd', rootReal)).toThrow(ERR.PATH_MUST_BE_RELATIVE);
});

test('rejects .. escape', () => {
  expect(() => resolveVaultPath('a/../../etc/passwd', rootReal)).toThrow(ERR.PATH_ESCAPES_VAULT_ROOT);
});

test('rejects symlink-escape outside vault', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  try {
    expect(() => resolveVaultPath('escape/file.md', rootReal)).toThrow(ERR.PATH_ESCAPES_VAULT_ROOT);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('accepts symlink that stays inside vault', () => {
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'a-link'));
  expect(resolveVaultPath('a-link/b/file.md', rootReal)).toBe(path.join(rootReal, 'a/b/file.md'));
});
