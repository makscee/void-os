// VOS-106: shared path-matching primitive consumed by both the
// in-daemon PermissionEngine and the standalone PreToolUse hook script
// (daemon/src/providers/claude-code/hook-bin/pre-tool-use.ts). Single
// source of truth for glob semantics + path normalization so the two
// enforcement entry points cannot drift.

import * as path from "node:path";
import picomatch from "picomatch";

const PICOMATCH_OPTS: picomatch.PicomatchOptions = { dot: true, nocase: false };

export function matchPath(absPath: string, patterns: readonly string[]): boolean {
  if (!path.isAbsolute(absPath)) {
    throw new TypeError(`matchPath: absPath must be absolute, got ${JSON.stringify(absPath)}`);
  }
  if (patterns.length === 0) return false;
  const normalized = path.resolve(absPath);
  return patterns.some((pat) => picomatch(pat, PICOMATCH_OPTS)(normalized));
}
