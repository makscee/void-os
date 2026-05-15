// VOS-85 permission engine. See docs/superpowers/specs/2026-05-15-vos-85-permission-engine-design.md.

export interface AgentDefn {
  name: string;
  read_scope?: string[];
  write_scope?: string[];
}

export interface ResolvedScopes {
  readPaths: string[];
  writePaths: string[];
}

export interface EngineOptions {
  vaultRoot: string;
  homeRoot: string;
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
}

export interface PermissionEngine {
  resolveScopes(agent: AgentDefn): ResolvedScopes;
  canRead(absPath: string, agent: AgentDefn): boolean;
  canWrite(absPath: string, agent: AgentDefn): boolean;
}

export class ZeroScopeError extends Error {
  constructor(public agent: string) {
    super(`agent ${agent}: zero scope paths resolved`);
    this.name = 'ZeroScopeError';
  }
}

export const SYSTEM_DENY_FOR_WRITE: readonly string[] = [
  'vault/agents/**',
  'vault/.void/**',
  'vault/.obsidian/**',
  '~/.claude/**',
  '~/.void-os/**',
];

export function createPermissionEngine(_opts: EngineOptions): PermissionEngine {
  return {
    resolveScopes() { throw new Error('not implemented'); },
    canRead() { throw new Error('not implemented'); },
    canWrite() { throw new Error('not implemented'); },
  };
}
