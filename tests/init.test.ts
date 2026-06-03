/**
 * init.ts — tests for seedVault (file layout) and non-interactive vault resolution.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, lstatSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { seedVault, preseedCCTrust, runInit } from "../src/init.ts";
import { readConfig, writeConfig, expandPath } from "../src/paths.ts";

// ---- VOS-229: init path tilde / $HOME expansion ----

test("expandPath expands a leading ~/ to the home dir", () => {
  expect(expandPath("~/vault", "/home/testuser")).toBe("/home/testuser/vault");
});

test("expandPath expands a bare ~ to the home dir", () => {
  expect(expandPath("~", "/home/testuser")).toBe("/home/testuser");
});

test("expandPath expands a leading $HOME/ to the home dir", () => {
  expect(expandPath("$HOME/somevault", "/home/testuser")).toBe("/home/testuser/somevault");
});

test("expandPath expands a bare $HOME to the home dir", () => {
  expect(expandPath("$HOME", "/home/testuser")).toBe("/home/testuser");
});

test("expandPath does NOT expand a ~ that is not at the start", () => {
  // a/~/b is a real (if odd) relative path — only a LEADING ~ is a home reference
  expect(expandPath("/abs/~/b", "/home/testuser")).toBe("/abs/~/b");
});

test("expandPath resolves a plain relative path against cwd (no ~)", () => {
  expect(expandPath("subdir", "/home/testuser")).toBe(resolve("subdir"));
});

test("expandPath leaves an absolute path absolute", () => {
  expect(expandPath("/tmp/myvault", "/home/testuser")).toBe("/tmp/myvault");
});

test("expandPath trims surrounding whitespace before expanding", () => {
  expect(expandPath("  ~/vault  ", "/home/testuser")).toBe("/home/testuser/vault");
});

test("expandPath defaults to $HOME (or os.homedir()) when no override given", () => {
  const home = process.env.HOME ?? homedir();
  expect(expandPath("~/x")).toBe(join(home, "x"));
});

// Integration: runInit with a "$HOME/..."-style positional arg must create the real
// home-relative vault and NEVER a literal "~" directory under cwd.
test("runInit expands a ~/ positional arg to HOME and creates no literal ~ dir", async () => {
  const fakeHome = `/tmp/voidos-init-home-${Date.now()}`;
  mkdirSync(fakeHome, { recursive: true });
  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  // homedir() honours $HOME on posix; set it so expandPath resolves into fakeHome.
  process.env.HOME = fakeHome;
  // Move cwd somewhere isolated so we can detect a stray literal "~" dir if expansion regresses.
  const cwdSandbox = `/tmp/voidos-init-cwd-${Date.now()}`;
  mkdirSync(cwdSandbox, { recursive: true });
  process.chdir(cwdSandbox);
  try {
    await runInit("~/myvault");
    // Real, expanded vault exists
    expect(existsSync(join(fakeHome, "myvault"))).toBe(true);
    expect(existsSync(join(fakeHome, "myvault", "void-os.json"))).toBe(true);
    // void-os.json records the RESOLVED absolute path, not the raw "~" string
    const cfg = JSON.parse(readFileSync(join(fakeHome, "myvault", "void-os.json"), "utf8"));
    expect(cfg.vault).toBe(join(fakeHome, "myvault"));
    // No literal "~" directory created under cwd
    expect(existsSync(join(cwdSandbox, "~"))).toBe(false);
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(cwdSandbox, { recursive: true, force: true });
  }
});

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

// VOS-203: cold vault seeds only onboarding + authoring toolchain, NOT the full catalog
test("cold vault seeds only onboarding + authoring toolchain, not the full catalog", () => {
  seedVault(vault);
  const installed = readdirSync(join(vault, ".claude", "skills")).sort();
  expect(installed).toEqual(["onboarding", "skill-author", "skill-manage-apply"]);
  expect(installed).not.toContain("work");
  expect(installed).not.toContain("chat");
  expect(installed).not.toContain("deep-research");
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

// ---- VOS-223: CC trust pre-seeding tests ----

const TRUST_TMP_BASE = "/tmp/voidos-trust-test";

test("preseedCCTrust creates ~/.claude.json with trust flags when file is absent", () => {
  const fakeHome = `${TRUST_TMP_BASE}-absent-${Date.now()}`;
  mkdirSync(fakeHome, { recursive: true });
  try {
    const claudeJsonPath = join(fakeHome, ".claude.json");
    expect(existsSync(claudeJsonPath)).toBe(false);

    preseedCCTrust(vault, fakeHome);

    expect(existsSync(claudeJsonPath)).toBe(true);
    const config = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    const vaultAbs = resolve(vault);
    expect(config.projects).toBeDefined();
    expect(config.projects[vaultAbs]).toBeDefined();
    // Hard-fail: both flags must be true
    expect(config.projects[vaultAbs].hasTrustDialogAccepted).toBe(true);
    expect(config.projects[vaultAbs].hasCompletedProjectOnboarding).toBe(true);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("preseedCCTrust merges into existing ~/.claude.json without clobbering sibling data", () => {
  const fakeHome = `${TRUST_TMP_BASE}-merge-${Date.now()}`;
  mkdirSync(fakeHome, { recursive: true });
  try {
    const claudeJsonPath = join(fakeHome, ".claude.json");
    const existingConfig = {
      numStartups: 42,
      someOtherKey: "keep-me",
      projects: {
        "/other/vault": { hasTrustDialogAccepted: true },
      },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(existingConfig, null, 2) + "\n");

    preseedCCTrust(vault, fakeHome);

    const config = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    const vaultAbs = resolve(vault);
    // Trust flags written for the new vault
    expect(config.projects[vaultAbs].hasTrustDialogAccepted).toBe(true);
    expect(config.projects[vaultAbs].hasCompletedProjectOnboarding).toBe(true);
    // Sibling project preserved
    expect(config.projects["/other/vault"].hasTrustDialogAccepted).toBe(true);
    // Top-level sibling keys preserved
    expect(config.numStartups).toBe(42);
    expect(config.someOtherKey).toBe("keep-me");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("preseedCCTrust preserves existing keys on the same vault path (no clobber)", () => {
  const fakeHome = `${TRUST_TMP_BASE}-preserve-${Date.now()}`;
  mkdirSync(fakeHome, { recursive: true });
  try {
    const claudeJsonPath = join(fakeHome, ".claude.json");
    const vaultAbs = resolve(vault);
    const existingConfig = {
      projects: {
        [vaultAbs]: { someExistingKey: "do-not-delete", hasTrustDialogAccepted: false },
      },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(existingConfig, null, 2) + "\n");

    preseedCCTrust(vault, fakeHome);

    const config = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    // Trust flags overwritten to true
    expect(config.projects[vaultAbs].hasTrustDialogAccepted).toBe(true);
    expect(config.projects[vaultAbs].hasCompletedProjectOnboarding).toBe(true);
    // Existing key on same path preserved
    expect(config.projects[vaultAbs].someExistingKey).toBe("do-not-delete");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("preseedCCTrust handles malformed ~/.claude.json gracefully (re-creates it)", () => {
  const fakeHome = `${TRUST_TMP_BASE}-malformed-${Date.now()}`;
  mkdirSync(fakeHome, { recursive: true });
  try {
    const claudeJsonPath = join(fakeHome, ".claude.json");
    writeFileSync(claudeJsonPath, "{ this is not valid JSON !!!  }");

    // Must not throw
    preseedCCTrust(vault, fakeHome);

    const config = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    const vaultAbs = resolve(vault);
    expect(config.projects[vaultAbs].hasTrustDialogAccepted).toBe(true);
    expect(config.projects[vaultAbs].hasCompletedProjectOnboarding).toBe(true);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("preseedCCTrust is idempotent — calling twice produces same result", () => {
  const fakeHome = `${TRUST_TMP_BASE}-idempotent-${Date.now()}`;
  mkdirSync(fakeHome, { recursive: true });
  try {
    preseedCCTrust(vault, fakeHome);
    preseedCCTrust(vault, fakeHome);  // second call must not throw

    const claudeJsonPath = join(fakeHome, ".claude.json");
    const config = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    const vaultAbs = resolve(vault);
    expect(config.projects[vaultAbs].hasTrustDialogAccepted).toBe(true);
    expect(config.projects[vaultAbs].hasCompletedProjectOnboarding).toBe(true);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("seedVault writes CC trust flags to ~/.claude.json via preseedCCTrust (wiring check)", () => {
  // Redirect HOME via env to avoid mutating the real ~/.claude.json
  const fakeHome = `${TRUST_TMP_BASE}-seedvault-wiring-${Date.now()}`;
  mkdirSync(fakeHome, { recursive: true });
  const origHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    seedVault(vault);

    // Hard-fail: trust flags MUST be present — this is the load-bearing wiring check
    const claudeJsonPath = join(fakeHome, ".claude.json");
    if (!existsSync(claudeJsonPath)) {
      throw new Error("WIRING FAIL: ~/.claude.json not created by seedVault");
    }
    const config = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    const vaultAbs = resolve(vault);
    if (!config.projects?.[vaultAbs]?.hasTrustDialogAccepted) {
      throw new Error(`WIRING FAIL: hasTrustDialogAccepted not set for ${vaultAbs}`);
    }
    if (!config.projects?.[vaultAbs]?.hasCompletedProjectOnboarding) {
      throw new Error(`WIRING FAIL: hasCompletedProjectOnboarding not set for ${vaultAbs}`);
    }
    expect(config.projects[vaultAbs].hasTrustDialogAccepted).toBe(true);
    expect(config.projects[vaultAbs].hasCompletedProjectOnboarding).toBe(true);
  } finally {
    process.env.HOME = origHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
