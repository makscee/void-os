// init.ts — preflight, vault pick, seed, vc login (Task 13)
// Non-interactive path: pass vault dir as first positional arg or via VOID_OS_VAULT env.
// Interactive fallback: readline menu (requires a TTY).
import { mkdirSync, cpSync, copyFileSync, existsSync, rmSync, lstatSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkPrereqs, realDeps } from "./preflight.ts";
import { writeConfig, readConfig } from "./paths.ts";
import { buildVaultHookSettings } from "./hooks-endpoint.ts";
import { hookRelayScriptPath } from "./spawn.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Seed vault floor: directory structure + files from templates + catalog.
 *  Writes vault-level .claude/settings.json with lifecycle hooks (VOS-197 vault-native). */
export function seedVault(vault: string): void {
  const claudeDir = join(vault, ".claude");

  // Replace any stale skills symlink (worktree-collision class, Q3=a) with a real dir.
  const skillsPath = join(claudeDir, "skills");
  try {
    if (lstatSync(skillsPath).isSymbolicLink()) rmSync(skillsPath);
  } catch { /* path doesn't exist yet — that's fine */ }

  mkdirSync(skillsPath, { recursive: true });
  mkdirSync(join(claudeDir, "agents"), { recursive: true });
  mkdirSync(join(vault, "sessions"), { recursive: true });

  // Write vault-level settings.json with lifecycle hooks (no per-exec runId baked in).
  // The daemon /hook route derives runId from session_id for hand-launched sessions.
  const daemonUrl = process.env.VOID_OS_DAEMON_URL ?? "http://127.0.0.1:4317";
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify(buildVaultHookSettings(hookRelayScriptPath, daemonUrl), null, 2),
  );

  const tmpl = join(repoRoot, "templates", "CLAUDE.md");
  if (existsSync(tmpl)) {
    copyFileSync(tmpl, join(vault, "CLAUDE.md"));
  }

  const onboardingSkill = join(repoRoot, "catalog", "skills", "onboarding");
  if (existsSync(onboardingSkill)) {
    cpSync(onboardingSkill, join(claudeDir, "skills", "onboarding"), { recursive: true });
  }

  const agentsDir = join(repoRoot, "catalog", "agents");
  if (existsSync(agentsDir)) {
    cpSync(agentsDir, join(claudeDir, "agents"), { recursive: true });
  }

  // Sync all catalog skills to vault .claude/skills so CC slash-command routing finds them.
  const catalogSkillsDir = join(repoRoot, "catalog", "skills");
  if (existsSync(catalogSkillsDir)) {
    cpSync(catalogSkillsDir, skillsPath, { recursive: true });
  }
}

/** Resolve vault dir: positional arg[0] > VOID_OS_VAULT env > interactive pick. */
async function pickVault(
  positionalArg: string | undefined,
  env: Record<string, string | undefined>,
  isTty: boolean,
): Promise<string> {
  // Non-interactive paths
  if (positionalArg) return positionalArg;
  if (env.VOID_OS_VAULT) return env.VOID_OS_VAULT;

  // Interactive path — only when there's a TTY
  if (!isTty) {
    console.error(
      "void-os init: no vault dir provided and no TTY available.\n" +
      "Pass a vault dir: void-os init <dir>  or  set VOID_OS_VAULT=<dir>",
    );
    process.exit(1);
  }

  // Same @clack/prompts UI as the top-level menu (tui.ts) for a consistent look.
  const p = await import("@clack/prompts");
  const def = join(env.HOME ?? "/tmp", "void-os");
  const choice = await p.select<string>({
    message: "vault folder?",
    options: [
      { value: "default", label: "default", hint: def },
      { value: "cwd", label: "current dir", hint: process.cwd() },
      { value: "custom", label: "custom", hint: "enter a path" },
    ],
  });
  if (p.isCancel(choice)) {
    p.cancel("cancelled");
    process.exit(0);
  }
  let vault = def;
  if (choice === "cwd") vault = process.cwd();
  else if (choice === "custom") {
    const custom = await p.text({ message: "path:", placeholder: def });
    if (p.isCancel(custom)) {
      p.cancel("cancelled");
      process.exit(0);
    }
    vault = String(custom).trim();
  }
  return vault;
}

export async function runInit(
  /** Positional arg: the vault dir (passed from cli.ts). Undefined = interactive. */
  vaultArg?: string,
): Promise<void> {
  const isTty = Boolean(process.stdin.isTTY);
  const vault = await pickVault(vaultArg, process.env as Record<string, string | undefined>, isTty);

  // Preflight (vc/claude/login) — skip hard-fail when running non-interactively so
  // G6 E2E can seed a fresh vault even if vc isn't logged in yet.
  const pre = await checkPrereqs(realDeps);
  if (!pre.ok) {
    for (const p of pre.problems) console.error("  ! " + p);
    if (pre.needsLogin && isTty && spawnSync("which", ["vc"]).status === 0) {
      console.log("launching `vc login`…");
      spawnSync("vc", ["login"], { stdio: "inherit" });
    }
    // In non-interactive mode: warn but continue seeding (vc login can happen later)
    if (!isTty) {
      console.error("  (continuing non-interactive init — resolve the above before serving)");
    } else if (!pre.needsLogin) {
      console.error("resolve the above, then re-run `void-os init`.");
      process.exit(1);
    }
  }

  seedVault(vault);

  const cfg = readConfig(vault);
  cfg.vault = vault;
  writeConfig(cfg);

  console.log(`\nvoid-os vault ready at ${vault}\n  start it with: void-os serve`);
}
