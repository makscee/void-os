/**
 * init.ts — tests for seedVault (file layout) and non-interactive vault resolution.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seedVault } from "../src/init.ts";
import { readConfig, writeConfig } from "../src/paths.ts";

const TMP_BASE = "/tmp/voidos-init-test";
let vault: string;

beforeEach(() => {
  vault = `${TMP_BASE}-${Date.now()}`;
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("seedVault creates required directory structure", () => {
  seedVault(vault);
  expect(existsSync(join(vault, "sessions"))).toBe(true);
  expect(existsSync(join(vault, ".claude", "skills"))).toBe(true);
  expect(existsSync(join(vault, ".claude", "agents"))).toBe(true);
});

test("seedVault copies templates/CLAUDE.md when it exists", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tmplSrc = join(repoRoot, "templates", "CLAUDE.md");

  if (!existsSync(tmplSrc)) {
    // Template not yet seeded — skip (G5 concern, not G4)
    return;
  }

  seedVault(vault);
  expect(existsSync(join(vault, "CLAUDE.md"))).toBe(true);
  const content = readFileSync(join(vault, "CLAUDE.md"), "utf8");
  expect(content).toContain("void-os session");
});

test("seedVault is idempotent — second call does not throw", () => {
  seedVault(vault);
  seedVault(vault);  // should not throw
  expect(existsSync(join(vault, "sessions"))).toBe(true);
});

// --- readConfig / writeConfig round-trip (integration with paths.ts) ---

test("readConfig returns defaults when void-os.json absent", () => {
  const cfg = readConfig(vault);
  expect(cfg.vault).toBe(vault);
  expect(cfg.port).toBe(4317);
  expect(cfg.onboarded).toBe(false);
});

test("writeConfig + readConfig round-trips a config", () => {
  writeConfig({ vault, onboarded: true, skills: ["onboarding"], answers: { name: "Maks" }, port: 5000,
    runners: [{ label: "vc (relay)", command: "vc --" }], defaultRunner: "vc (relay)" });
  const cfg = readConfig(vault);
  expect(cfg.onboarded).toBe(true);
  expect(cfg.port).toBe(5000);
  expect(cfg.skills).toEqual(["onboarding"]);
  expect(cfg.answers.name).toBe("Maks");
});

test("readConfig repairs missing optional fields from old JSON", () => {
  writeFileSync(join(vault, "void-os.json"), JSON.stringify({ vault, onboarded: false }));
  const cfg = readConfig(vault);
  expect(cfg.port).toBe(4317);
  expect(cfg.skills).toEqual([]);
  expect(cfg.answers).toEqual({});
});

// ---- VOS-197: vault-native seedVault tests ----

test("seedVault writes a vault-level .claude/settings.json with lifecycle hooks", () => {
  seedVault(vault);
  const settingsPath = join(vault, ".claude", "settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(s.hooks.SessionStart).toBeDefined();
  expect(s.hooks.Stop).toBeDefined();
  expect(s.hooks.SessionEnd).toBeDefined();
  expect(s.hooks.PreToolUse).toBeDefined();
  // Must not have a baked run id (vault-level = no per-exec runId)
  const cmd = s.hooks.SessionStart[0].hooks[0].command;
  expect(cmd).not.toMatch(/exec-/);
});

test("seedVault replaces stale skills symlink with a real directory", () => {
  // Create a stale symlink as void-os used to have in ~/void/.claude/skills -> ../skills
  mkdirSync(join(vault, ".claude"), { recursive: true });
  symlinkSync("../skills", join(vault, ".claude", "skills"));
  expect(lstatSync(join(vault, ".claude", "skills")).isSymbolicLink()).toBe(true);

  seedVault(vault);

  const stat = lstatSync(join(vault, ".claude", "skills"));
  expect(stat.isSymbolicLink()).toBe(false);
  expect(stat.isDirectory()).toBe(true);
});

test("seedVault is idempotent after settings.json exists — second call does not throw", () => {
  seedVault(vault);
  seedVault(vault);  // should not throw
  expect(existsSync(join(vault, ".claude", "settings.json"))).toBe(true);
});

test("init seeding: void-os.json carries runners and defaultRunner after init path", () => {
  // Simulate what init() does: seedVault then readConfig + writeConfig
  seedVault(vault);
  const cfg = readConfig(vault);
  cfg.vault = vault;
  cfg.onboarded = true;
  writeConfig(cfg);
  // Read back the written file to assert runners are persisted
  const written = JSON.parse(readFileSync(join(vault, "void-os.json"), "utf8"));
  expect(Array.isArray(written.runners)).toBe(true);
  expect(written.runners.length).toBeGreaterThan(0);
  expect(written.runners[0].label).toBe("vc (relay)");
  expect(written.runners[0].command).toBe("vc --");
  expect(written.defaultRunner).toBe("vc (relay)");
});
