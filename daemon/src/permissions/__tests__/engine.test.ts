import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
  createPermissionEngine,
  resolveSystemDeny,
  SYSTEM_DENY_FOR_WRITE,
  ZeroScopeError,
  __test__,
  type AgentDefn,
  type PermissionEngine,
} from '../engine';
import { matchPath } from '../match';

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

// VOS-106 T11.2+3: lock in the parity contract between the engine's internal
// SYSTEM_DENY check and the spawner's out-of-process re-expansion. The hook
// running in the CC child process gets `expandedDeny` via env (via
// `resolveSystemDeny`); the engine checks `canWrite` against its own
// expansion. If those two ever diverge, the hook and engine will disagree on
// what's writable — exactly the drift T11 was opened to eliminate.
describe('SYSTEM_DENY parity (engine canWrite vs resolveSystemDeny)', () => {
  const VAULT = '/tmp/vos-test-vault';
  const HOME  = '/tmp/vos-test-home';
  const eng = createPermissionEngine({ vaultRoot: VAULT, homeRoot: HOME });
  // Agent with maximally permissive write_scope, so the only thing that can
  // make canWrite return false is the SYSTEM_DENY check itself.
  const agent: AgentDefn = {
    name: 'parity',
    read_scope: ['vault/**', '~/**', '/tmp/**'],
    write_scope: ['vault/**', '~/**', '/tmp/**'],
  };
  const expandedDeny = resolveSystemDeny({ vaultRoot: VAULT, homeRoot: HOME });

  test('engine exposes vaultRoot and homeRoot for spawner reuse', () => {
    expect(eng.vaultRoot).toBe(VAULT);
    expect(eng.homeRoot).toBe(HOME);
  });

  test('resolveSystemDeny produces the SYSTEM_DENY count', () => {
    expect(expandedDeny.length).toBe(SYSTEM_DENY_FOR_WRITE.length);
  });

  // 20 absolute paths: 10 inside SYSTEM_DENY zones, 10 outside. The boolean
  // returned by canWrite() under a wide-open write_scope must equal the
  // negation of matchPath(absPath, expandedDeny) — that's the parity
  // contract the spawner+hook depend on.
  const paths: string[] = [
    // Inside SYSTEM_DENY
    `${VAULT}/agents/maya/agent.md`,
    `${VAULT}/agents/journaler/agent.md`,
    `${VAULT}/.void/state.json`,
    `${VAULT}/.void/nested/deep.json`,
    `${VAULT}/.obsidian/workspace.json`,
    `${VAULT}/.obsidian/plugins/foo/main.js`,
    `${HOME}/.claude/settings.json`,
    `${HOME}/.claude/plugins/x.ts`,
    `${HOME}/.void-os/db.sqlite`,
    `${HOME}/.void-os/keys/a`,
    // Outside SYSTEM_DENY
    `${VAULT}/notes/a.md`,
    `${VAULT}/journal/2026-05-16.md`,
    `${VAULT}/inbox/x.md`,
    `${VAULT}/work/tasks/active/X.md`,
    `${VAULT}/agentsfoo/x.md`,         // not under agents/
    `${VAULT}/.voidish/y.md`,          // not .void/
    `${HOME}/Downloads/x.txt`,
    `${HOME}/.claudish/x`,             // not .claude/
    `${HOME}/.void-os-stuff/x`,        // not .void-os/
    `/tmp/x/y.txt`,
  ];

  for (const p of paths) {
    test(`parity: canWrite(${p}) === !matchPath(SYSTEM_DENY)`, () => {
      const engineAllows = eng.canWrite(p, agent);
      const denyHit = matchPath(p, expandedDeny);
      // Under a wide-open write_scope, canWrite returns true iff no deny hit.
      expect(engineAllows).toBe(!denyHit);
    });
  }
});
