import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
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

  test('~/../etc escape is rejected (traversal escapes homeRoot)', () => {
    const r = __test__.expandPattern('~/../etc/passwd', opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/escape|traversal|anchor/i);
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
    expect(warns[0]!.msg).toMatch(/notes\/\*\*/);
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

describe('canRead / canWrite', () => {
  const VAULT = '/tmp/vos-test-vault';
  const HOME  = '/tmp/vos-test-home';
  const eng = createPermissionEngine({ vaultRoot: VAULT, homeRoot: HOME });

  const agentVault: AgentDefn = { name: 'maya', read_scope: ['vault/**'], write_scope: ['vault/**'] };
  const agentHome:  AgentDefn = { name: 'dl',   read_scope: ['~/Downloads/**'] };
  const agentTmp:   AgentDefn = { name: 'tmp',  read_scope: ['/tmp/x/**'] };

  test('vault-relative read matches', () => {
    expect(eng.canRead(path.join(VAULT, 'notes/foo.md'), agentVault)).toBe(true);
  });

  test('~ expansion read matches', () => {
    expect(eng.canRead(path.join(HOME, 'Downloads/x.txt'), agentHome)).toBe(true);
  });

  test('absolute literal read matches', () => {
    expect(eng.canRead('/tmp/x/y', agentTmp)).toBe(true);
  });

  test('canWrite: SYSTEM_DENY blocks vault/agents even when write_scope=vault/**', () => {
    expect(eng.canWrite(path.join(VAULT, 'agents/maya/agent.md'), agentVault)).toBe(false);
  });

  test('canWrite: SYSTEM_DENY blocks vault/.obsidian/** dotfiles', () => {
    expect(eng.canWrite(path.join(VAULT, '.obsidian/workspace.json'), agentVault)).toBe(false);
  });

  test('canWrite: SYSTEM_DENY blocks vault/.void/** dotfiles', () => {
    expect(eng.canWrite(path.join(VAULT, '.void/state.json'), agentVault)).toBe(false);
  });

  test('canRead: SYSTEM_DENY paths remain readable', () => {
    expect(eng.canRead(path.join(VAULT, 'agents/maya/agent.md'), agentVault)).toBe(true);
  });

  test('canWrite default-deny outside scope', () => {
    expect(eng.canWrite(path.join(VAULT, '..', 'outside.md'), agentVault)).toBe(false);
  });

  test('canRead default-deny outside scope', () => {
    expect(eng.canRead(path.join(VAULT, '..', 'outside.md'), agentVault)).toBe(false);
  });

  test('canRead throws TypeError on relative input', () => {
    expect(() => eng.canRead('notes/foo.md', agentVault)).toThrow(TypeError);
  });

  test('canWrite throws TypeError on relative input', () => {
    expect(() => eng.canWrite('notes/foo.md', agentVault)).toThrow(TypeError);
  });
});
