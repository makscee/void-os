// install-skill.test.ts — TDD for the catalog skill install primitive (VOS-235)
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installCatalogSkill, type InstallSkillResult } from "../src/install-skill.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let tmpRoot: string;
let fakeVault: string;
let fakeCatalogRoot: string;

beforeEach(() => {
  tmpRoot = `/tmp/vos-install-skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fakeVault = join(tmpRoot, "vault");
  fakeCatalogRoot = join(tmpRoot, "catalog");

  // Fake catalog: three skills
  for (const name of ["deep-research", "skill-author", "idea-intake"]) {
    const dir = join(fakeCatalogRoot, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} description.\n---\n## Instructions\nDo ${name} stuff.\n`,
    );
    // Some skills have extra files
    writeFileSync(join(dir, "extra.txt"), `extra content for ${name}`);
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// --- HAPPY PATH ---

test("installs a known catalog skill into vault/.claude/skills/", () => {
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "deep-research" });
  expect(result.ok).toBe(true);
  const destSkillMd = join(fakeVault, ".claude", "skills", "deep-research", "SKILL.md");
  expect(existsSync(destSkillMd)).toBe(true);
  const content = readFileSync(destSkillMd, "utf8");
  expect(content).toContain("name: deep-research");
});

test("copies all files in the skill directory, not just SKILL.md", () => {
  installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "deep-research" });
  const extraDest = join(fakeVault, ".claude", "skills", "deep-research", "extra.txt");
  expect(existsSync(extraDest)).toBe(true);
  expect(readFileSync(extraDest, "utf8")).toBe("extra content for deep-research");
});

test("is idempotent — re-install overwrites cleanly without error", () => {
  installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "skill-author" });
  // Mutate the installed copy
  writeFileSync(join(fakeVault, ".claude", "skills", "skill-author", "SKILL.md"), "STALE");
  // Re-install should overwrite
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "skill-author" });
  expect(result.ok).toBe(true);
  const content = readFileSync(join(fakeVault, ".claude", "skills", "skill-author", "SKILL.md"), "utf8");
  expect(content).toContain("name: skill-author");
  expect(content).not.toBe("STALE");
});

test("creates vault/.claude/skills/ if it does not exist", () => {
  // vault dir itself doesn't exist yet
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "idea-intake" });
  expect(result.ok).toBe(true);
  expect(existsSync(join(fakeVault, ".claude", "skills", "idea-intake", "SKILL.md"))).toBe(true);
});

test("returns destDir in result on success", () => {
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "deep-research" });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.destDir).toBe(join(fakeVault, ".claude", "skills", "deep-research"));
  }
});

// --- REJECTION CASES (no rm of possibly-empty path) ---

test("rejects empty name — returns error, no rm of empty path", () => {
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatch(/empty/i);
  }
});

test("rejects name with path traversal (..) — returns error", () => {
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "../evil" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatch(/traversal|invalid/i);
  }
});

test("rejects name with leading slash — returns error", () => {
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "/etc/passwd" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatch(/traversal|invalid/i);
  }
});

test("rejects name with embedded slash — returns error", () => {
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "foo/bar" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatch(/traversal|invalid/i);
  }
});

test("rejects unknown skill name — returns error, does not write anything", () => {
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: fakeCatalogRoot, name: "does-not-exist" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatch(/not found|unknown/i);
  }
  // Vault should have nothing installed
  expect(existsSync(join(fakeVault, ".claude", "skills", "does-not-exist"))).toBe(false);
});

// --- REAL CATALOG ---

test("installs from the real catalog when not using fake", () => {
  const realCatalog = join(repoRoot, "catalog");
  const result = installCatalogSkill({ vault: fakeVault, catalogRoot: realCatalog, name: "deep-research" });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(existsSync(join(result.destDir, "SKILL.md"))).toBe(true);
  }
});

// --- NO RM OF POSSIBLY-EMPTY PATH (structural: function uses cpSync, not shell rm) ---

test("function source uses cpSync not rm-rf shell pattern (static guard)", async () => {
  // This test verifies the implementation contract: no rm -rf on variable paths.
  // We read the source and assert it does NOT contain shell rm patterns.
  const src = await Bun.file(join(repoRoot, "src", "install-skill.ts")).text();
  // Must not have shell rm -rf with variable
  expect(src).not.toMatch(/rm\s+-rf\s+"\$\{/);
  expect(src).not.toMatch(/rm\s+-rf\s+"\$[A-Z_]+\//);
  // Must use cpSync
  expect(src).toContain("cpSync");
});
