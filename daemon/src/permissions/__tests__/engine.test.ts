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

describe('resolveScopes', () => {
  const VAULT = '/tmp/vos-test-vault';
  const HOME  = '/tmp/vos-test-home';

  test('default scopes when both fields undefined', () => {
    const eng = createPermissionEngine({ vaultRoot: VAULT, homeRoot: HOME });
    const r = eng.resolveScopes({ name: 'maya' });
    expect(r.readPaths).toEqual([`${VAULT}/**`]);
    expect(r.writePaths).toEqual([`${VAULT}/**`]);
  });

  test('write_scope undefined mirrors resolved read_scope', () => {
    const eng = createPermissionEngine({ vaultRoot: VAULT, homeRoot: HOME });
    const r = eng.resolveScopes({ name: 'maya', read_scope: ['vault/notes/**'] });
    expect(r.readPaths).toEqual([`${VAULT}/notes/**`]);
    expect(r.writePaths).toEqual([`${VAULT}/notes/**`]);
  });

  test('bad patterns are dropped, good ones survive, logger.warn called', () => {
    const warns: Array<{ msg: string; ctx?: unknown }> = [];
    const eng = createPermissionEngine({
      vaultRoot: VAULT, homeRoot: HOME,
      logger: { warn: (msg, ctx) => warns.push({ msg, ctx }) },
    });
    const r = eng.resolveScopes({
      name: 'maya',
      read_scope: ['notes/**', 'vault/notes/**'],
    });
    expect(r.readPaths).toEqual([`${VAULT}/notes/**`]);
    expect(warns.length).toBe(1);
    expect(warns[0].msg).toMatch(/notes\/\*\*/);
  });

  test('ZeroScopeError when every read_scope pattern is invalid', () => {
    const eng = createPermissionEngine({ vaultRoot: VAULT, homeRoot: HOME });
    expect(() => eng.resolveScopes({ name: 'maya', read_scope: ['notes/**'] }))
      .toThrow(ZeroScopeError);
  });

  test('ZeroScopeError carries agent name', () => {
    const eng = createPermissionEngine({ vaultRoot: VAULT, homeRoot: HOME });
    try {
      eng.resolveScopes({ name: 'journaler', read_scope: ['nope/**'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZeroScopeError);
      expect((e as ZeroScopeError).agent).toBe('journaler');
    }
  });
});
