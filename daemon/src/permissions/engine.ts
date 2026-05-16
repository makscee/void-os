// VOS-85 permission engine. See docs/superpowers/specs/2026-05-15-vos-85-permission-engine-design.md.

import * as path from 'node:path';
import picomatch from 'picomatch';
import { matchPath } from './match';

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
  /**
   * VOS-89: optional allowlist of agent names this agent may target via the
   * ask_agent tool. `undefined` means "no allowlist enforced at the agent
   * level" (system-level rules still apply). An empty array means "may not
   * ask any agent".
   */
  ask_agent_allow?: string[];
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

const DEFAULT_READ_SCOPE: ReadonlyArray<string> = ['vault/**'];

const PICOMATCH_OPTS: picomatch.PicomatchOptions = { dot: true, nocase: false };

export function createPermissionEngine(opts: EngineOptions): PermissionEngine {
  const expandOpts = { vaultRoot: opts.vaultRoot, homeRoot: opts.homeRoot };
  const warn = opts.logger?.warn ?? (() => {});

  // Compile SYSTEM_DENY matchers once. A bad SYSTEM_DENY pattern is a programmer
  // error (not config), so a missing expansion here is a hard failure.
  const denyMatchers: Array<(p: string) => boolean> = SYSTEM_DENY_FOR_WRITE.map((p) => {
    const r = expandPattern(p, expandOpts);
    if (!r.ok) {
      throw new Error(`permission: SYSTEM_DENY_FOR_WRITE has unresolvable pattern ${p}: ${r.reason}`);
    }
    return picomatch(r.expanded, PICOMATCH_OPTS);
  });

  function expandList(patterns: ReadonlyArray<string>): string[] {
    const out: string[] = [];
    for (const p of patterns) {
      const r = expandPattern(p, expandOpts);
      if (r.ok) out.push(r.expanded);
      else warn(`permission: dropping invalid pattern ${p}: ${r.reason}`, { pattern: p });
    }
    return out;
  }

  function resolveScopes(agent: AgentDefn): ResolvedScopes {
    const readInput  = agent.read_scope  ?? DEFAULT_READ_SCOPE;
    const readPaths  = expandList(readInput);
    if (readPaths.length === 0) throw new ZeroScopeError(agent.name);

    const writePaths = agent.write_scope === undefined
      ? [...readPaths]
      : expandList(agent.write_scope);

    return { readPaths, writePaths };
  }

  function compileScope(paths: string[]): (p: string) => boolean {
    return (p: string) => matchPath(p, paths);
  }

  function ensureAbs(absPath: string, fn: 'canRead' | 'canWrite'): void {
    if (!path.isAbsolute(absPath)) {
      throw new TypeError(`${fn}: absPath must be absolute, got ${JSON.stringify(absPath)}`);
    }
  }

  function canRead(absPath: string, agent: AgentDefn): boolean {
    ensureAbs(absPath, 'canRead');
    const { readPaths } = resolveScopes(agent);
    return compileScope(readPaths)(absPath);
  }

  function canWrite(absPath: string, agent: AgentDefn): boolean {
    ensureAbs(absPath, 'canWrite');
    if (denyMatchers.some((m) => m(absPath))) return false;
    const { writePaths } = resolveScopes(agent);
    return compileScope(writePaths)(absPath);
  }

  return { resolveScopes, canRead, canWrite };
}
