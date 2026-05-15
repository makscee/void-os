import { describe, expect, test } from 'bun:test';
import {
  createPermissionEngine,
  SYSTEM_DENY_FOR_WRITE,
  ZeroScopeError,
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
