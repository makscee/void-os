// install-skill.ts — safe deterministic catalog skill installer (VOS-235).
// Copies <catalogRoot>/skills/<name>/ → <vault>/.claude/skills/<name>/ using
// Node's cpSync — NO shell rm of variable paths, NO improvised bash.
// Used by: bin/void-os install-skill <name>  AND  the onboarding SKILL.md step 3.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface InstallSkillOpts {
  vault: string;       // absolute path to the vault
  catalogRoot: string; // absolute path to the catalog dir (contains skills/)
  name: string;        // skill name to install (e.g. "deep-research")
}

export type InstallSkillResult =
  | { ok: true; destDir: string }
  | { ok: false; error: string };

/** Validate a skill name: must be non-empty, slug-safe, no path traversal. */
function validateName(name: string): string | null {
  if (!name || name.trim().length === 0) return "empty skill name";
  // Reject path traversal: any slash or ..
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return `invalid skill name (path traversal not allowed): ${name}`;
  }
  // Reject absolute paths (starts with / or drive letter)
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    return `invalid skill name (path traversal not allowed): ${name}`;
  }
  return null;
}

/**
 * Install a named skill from the catalog into the vault's .claude/skills/ directory.
 *
 * Safe by construction:
 * - Name is validated (no empty, no path traversal) before any fs operation.
 * - Uses Node's cpSync with { recursive: true, force: true } — overwrites cleanly.
 * - No shell execution, no `rm -rf $VAR` pattern.
 * - Idempotent: re-installing overwrites the prior copy.
 *
 * @returns { ok: true, destDir } on success or { ok: false, error } on rejection.
 */
export function installCatalogSkill(opts: InstallSkillOpts): InstallSkillResult {
  const { vault, catalogRoot, name } = opts;

  // 1. Validate name
  const nameErr = validateName(name);
  if (nameErr) return { ok: false, error: nameErr };

  // 2. Verify source exists in catalog
  const srcDir = join(catalogRoot, "skills", name);
  if (!existsSync(srcDir)) {
    return { ok: false, error: `catalog skill not found: ${name}` };
  }

  // 3. Ensure destination parent exists
  const destParent = join(vault, ".claude", "skills");
  mkdirSync(destParent, { recursive: true });

  // 4. Copy — cpSync with force:true overwrites existing files idempotently
  const destDir = join(destParent, name);
  cpSync(srcDir, destDir, { recursive: true, force: true });

  return { ok: true, destDir };
}
