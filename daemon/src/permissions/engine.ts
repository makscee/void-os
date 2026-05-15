// VOS-85 permission engine. See docs/superpowers/specs/2026-05-15-vos-85-permission-engine-design.md.

import * as path from 'node:path';

type ExpandOk  = { ok: true;  expanded: string };
type ExpandErr = { ok: false; reason: string };
type ExpandResult = ExpandOk | ExpandErr;

const GLOB_META = /[*?[{]/;

function literalHead(pattern: string): string {
  const m = pattern.search(GLOB_META);
  return m === -1 ? pattern : pattern.slice(0, m);
}

function expandPattern(
  pattern: string,
  opts: { vaultRoot: string; homeRoot: string },
): ExpandResult {
  let expanded: string;
  let anchorRoot: string | null;

  if (pattern === 'vault' || pattern.startsWith('vault/')) {
    const rest = pattern === 'vault' ? '' : pattern.slice('vault/'.length);
    expanded = rest ? path.join(opts.vaultRoot, rest) : opts.vaultRoot;
    anchorRoot = opts.vaultRoot;
  } else if (pattern === '~' || pattern.startsWith('~/')) {
    const rest = pattern === '~' ? '' : pattern.slice('~/'.length);
    expanded = rest ? path.join(opts.homeRoot, rest) : opts.homeRoot;
    anchorRoot = opts.homeRoot;
  } else if (pattern.startsWith('/')) {
    expanded = pattern;
    anchorRoot = null;
  } else {
    return { ok: false, reason: `pattern lacks vault/, ~/, or / prefix: ${pattern}` };
  }

  if (anchorRoot) {
    const head = literalHead(expanded);
    const resolvedHead = path.resolve(head);
    const anchorResolved = path.resolve(anchorRoot);
    if (
      resolvedHead !== anchorResolved &&
      !resolvedHead.startsWith(anchorResolved + path.sep)
    ) {
      return {
        ok: false,
        reason: `pattern escapes anchor root ${anchorRoot}: literal head resolves to ${resolvedHead}`,
      };
    }
  }

  return { ok: true, expanded };
}

export const __test__ = { expandPattern, literalHead };

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
