// VOS-85 permission engine. See docs/superpowers/specs/2026-05-15-vos-85-permission-engine-design.md.

import * as path from 'node:path';
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
    // VOS-122 F10: bare patterns (no `vault/`, `~/`, or `/` prefix) are
    // vault-relative. This matches what the starter Tinker agent declares
    // (`read_scope: ['**']`, `write_scope: ['agents/**', 'CLAUDE.md', ...]`)
    // and what authors writing agent.md naturally expect. The traversal-escape
    // check below still rejects bare `../etc` style escapes.
    expanded = path.join(opts.vaultRoot, pattern);
    anchorRoot = opts.vaultRoot;
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

/**
 * VOS-106 T11.3: expand SYSTEM_DENY_FOR_WRITE into absolute glob patterns,
 * using the same `expandPattern` the engine uses internally. Exposed so the
 * CC spawner (which has to pass SYSTEM_DENY into a child process env) can
 * produce byte-for-byte identical patterns to the engine's deny check —
 * eliminating the prior hand-rolled prefix logic in claude-code/index.ts.
 *
 * A bad SYSTEM_DENY_FOR_WRITE pattern is a programmer error, not config,
 * so unresolvable patterns throw (matching the engine's behavior).
 */
export function resolveSystemDeny(opts: { vaultRoot: string; homeRoot: string }): string[] {
  return SYSTEM_DENY_FOR_WRITE.map((p) => {
    const r = expandPattern(p, opts);
    if (!r.ok) {
      throw new Error(`permission: SYSTEM_DENY_FOR_WRITE has unresolvable pattern ${p}: ${r.reason}`);
    }
    return r.expanded;
  });
}

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
  /**
   * VOS-122 F7: optional declared tool allowlist sourced from the agent.md
   * frontmatter `tools:` field. The CC spawner intersects this with the
   * maximal MCP tool set to compute the effective `--tools` arg. `undefined`
   * means the agent did not declare tools (legacy) — the spawner falls back
   * to the maximal set and emits a deprecation warning. An empty array means
   * "no MCP tools allowed".
   *
   * Names follow the registered MCP form (e.g. `vault.read`, `ask_agent`),
   * NOT the CC-emitted `mcp__void-os__vault_read` form.
   */
  tools?: string[];
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
  /** VOS-106 T11.3: roots used for pattern expansion — exposed so out-of-process
   *  callers (CC spawner hook env) can call `resolveSystemDeny` with the SAME
   *  roots the engine was built with, instead of re-deriving from `req.cwd`. */
  readonly vaultRoot: string;
  readonly homeRoot: string;
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

export function createPermissionEngine(opts: EngineOptions): PermissionEngine {
  const expandOpts = { vaultRoot: opts.vaultRoot, homeRoot: opts.homeRoot };
  const warn = opts.logger?.warn ?? (() => {});

  // VOS-106 T11.2: expand SYSTEM_DENY once via the shared helper, then run
  // each canWrite() through matchPath() — the single source of truth for
  // glob semantics + path normalization (shared with hook script). Previous
  // code called picomatch directly here, which meant any future change to
  // matchPath's normalization would silently bypass the deny check.
  const expandedSystemDeny: readonly string[] = resolveSystemDeny(expandOpts);

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
    if (matchPath(absPath, expandedSystemDeny)) return false;
    const { writePaths } = resolveScopes(agent);
    return compileScope(writePaths)(absPath);
  }

  return {
    resolveScopes,
    canRead,
    canWrite,
    vaultRoot: opts.vaultRoot,
    homeRoot: opts.homeRoot,
  };
}
