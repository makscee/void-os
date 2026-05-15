import { describe, expect, test } from 'bun:test';
import {
  createPermissionEngine,
  SYSTEM_DENY_FOR_WRITE,
  ZeroScopeError,
  __test__,
  type AgentDefn,
  type PermissionEngine,
} from '../engine';

const VAULT = '/tmp/vos-test-vault';
const HOME  = '/tmp/vos-test-home';

describe('engine surface', () => {
  test('SYSTEM_DENY_FOR_WRITE lists the 5 spec patterns', () => {
    expect(SYSTEM_DENY_FOR_WRITE).toEqual([
      'vault/agents/**',
      'vault/.void/**',
      'vault/.obsidian/**',
      '~/.claude/**',
      '~/.void-os/**',
    ]);
  });

  test('createPermissionEngine returns an object with the documented methods', () => {
    const eng: PermissionEngine = createPermissionEngine({ vaultRoot: VAULT, homeRoot: HOME });
    expect(typeof eng.resolveScopes).toBe('function');
    expect(typeof eng.canRead).toBe('function');
    expect(typeof eng.canWrite).toBe('function');
  });

  test('ZeroScopeError carries the agent name on its instance', () => {
    const e = new ZeroScopeError('maya');
    expect(e).toBeInstanceOf(Error);
    expect(e.agent).toBe('maya');
    expect(e.message).toContain('maya');
  });
});

describe('expandPattern', () => {
  const opts = { vaultRoot: '/vault', homeRoot: '/home/u' };

  test('vault/ prefix expands to vaultRoot', () => {
    const r = __test__.expandPattern('vault/notes/**', opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expanded).toBe('/vault/notes/**');
  });

  test('~/ prefix expands to homeRoot', () => {
    const r = __test__.expandPattern('~/Downloads/**', opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expanded).toBe('/home/u/Downloads/**');
  });

  test('absolute literal passes through', () => {
    const r = __test__.expandPattern('/tmp/x/**', opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expanded).toBe('/tmp/x/**');
  });

  test('bare relative pattern is rejected', () => {
    const r = __test__.expandPattern('notes/**', opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/prefix/i);
  });

  test('vault/../escape is rejected (traversal escapes vaultRoot)', () => {
    const r = __test__.expandPattern('vault/../../etc/passwd', opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/escape|traversal|anchor/i);
  });

  test('vault/notes/../inbox normalizes inside vaultRoot', () => {
    const r = __test__.expandPattern('vault/notes/../inbox/**', opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expanded).toBe('/vault/inbox/**');
  });
});
