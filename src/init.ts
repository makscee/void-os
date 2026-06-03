// init.ts — preflight, vault pick, seed, vc login (Task 13)
// Non-interactive path: pass vault dir as first positional arg or via VOID_OS_VAULT env.
// Interactive fallback: readline menu (requires a TTY).
import { mkdirSync, cpSync, copyFileSync, existsSync, rmSync, lstatSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkPrereqs, realDeps } from "./preflight.ts";
import { writeConfig, readConfig } from "./paths.ts";
import { buildVaultHookSettings } from "./hooks-endpoint.ts";
import { hookRelayScriptPath } from "./spawn.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pre-seed Claude Code trust for the vault directory in ~/.claude.json (VOS-223).
 *
 * CC stores per-project trust under `projects[absolutePath]` in ~/.claude.json.
 * Setting `hasTrustDialogAccepted` + `hasCompletedProjectOnboarding` to true
 * suppresses the interactive "Do you trust the files in this folder?" prompt,
 * preventing a 7-min stall on autonomous kickoff for fresh vaults.
 *
 * Safe: merges into existing file, preserves all sibling keys + other project entries.
 * Idempotent: re-running init does not clobber existing trust entries.
 *
 * @param vault   Absolute path to the vault directory.
 * @param homeDir Override for $HOME (used in tests to avoid mutating ~/.claude.json).
 */
export function preseedCCTrust(vault: string, homeDir?: string): void {
  const home = homeDir ?? process.env.HOME ?? "/tmp";
  const claudeJsonPath = join(home, ".claude.json");
  const vaultAbs = resolve(vault);

  // Read or create the base config
  let config: Record<string, unknown> = {};
  if (existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    } catch {
      // Malformed JSON — start fresh to avoid breaking CC entirely
      config = {};
    }
  }

  // Ensure projects map exists
  if (!config.projects || typeof config.projects !== "object" || Array.isArray(config.projects)) {
    config.projects = {};
  }
  const projects = config.projects as Record<string, Record<string, unknown>>;

  // Merge trust flags — preserve any existing keys for this path
  projects[vaultAbs] = {
    ...(projects[vaultAbs] ?? {}),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };

  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
}

/** Write vault-level .mcp.json so CC sessions in the vault can call the MCP server (VOS-199).
 *  The MCP server runs as a stdio process with VOID_OS_MCP_DIRECT=1 for direct vault access. */
export function writeMcpConfig(vault: string, repoRootOverride?: string): void {
  const rr = repoRootOverride ?? repoRoot;
  const mcpConfig = {
    mcpServers: {
      "void-os-skill-manage": {
        type: "stdio",
        command: "bun",
        args: ["run", join(rr, "src", "mcp-server.ts")],
        env: {
          VOID_OS_VAULT: vault,
          VOID_OS_MCP_DIRECT: "1",
        },
      },
    },
  };
  writeFileSync(join(vault, ".mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");
}

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

  // Seed the self-extension toolchain (VOS-203): skill-author + skill-manage-apply are system
  // primitives required for in-vault skill authoring. They are NOT user-installable catalog
  // skills and must NOT come via a bulk catalog copy — seed them explicitly alongside onboarding.
  for (const sk of ["skill-author", "skill-manage-apply"]) {
    const src = join(repoRoot, "catalog", "skills", sk);
    if (existsSync(src)) cpSync(src, join(claudeDir, "skills", sk), { recursive: true });
  }

  // Write .mcp.json so CC sessions in this vault can reach the skill_manage MCP server (VOS-199).
  writeMcpConfig(vault);

  // Pre-seed CC trust so autonomous kickoff never stalls on the interactive trust dialog (VOS-223).
  preseedCCTrust(vault);
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
