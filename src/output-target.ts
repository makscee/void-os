// output-target.ts — resolve a skill's declared output target + mtime-based mutation check.
// Mutation model (ADR-0003 §3, VOS-191): every execution is a FRESH session with a recorded
// started_at; "produced output" = the declared target exists AND was touched at/after start.
// mtime-since-start is chosen over content-hash (no prior in-memory baseline in the stateless
// model) and over git-diff (the vault is not guaranteed to be a git repo). Survives daemon
// restart: reads the fs + the started_at persisted in the event log.
import { existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

/** Resolve a vault-relative declared target to an absolute path (globs returned as-is, joined). */
export function resolveOutputTarget(vault: string, target: string): string {
  return join(vault, target);
}

/**
 * True iff the declared target was mutated at/after startedAtMs.
 * Supports a literal path or a single `*` glob in the basename (e.g. reports/*.html).
 * Empty target → never mutated.
 */
export function wasMutatedSince(vault: string, target: string, startedAtMs: number): boolean {
  if (!target) return false;
  const abs = join(vault, target);
  const base = basename(abs);
  if (base.includes("*")) {
    const dir = dirname(abs);
    if (!existsSync(dir)) return false;
    const re = new RegExp(
      "^" + base.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    for (const f of readdirSync(dir)) {
      if (!re.test(f)) continue;
      try { if (statSync(join(dir, f)).mtimeMs >= startedAtMs) return true; } catch { /* race */ }
    }
    return false;
  }
  if (!existsSync(abs)) return false;
  try { return statSync(abs).mtimeMs >= startedAtMs; } catch { return false; }
}
