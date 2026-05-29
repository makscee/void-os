// init.ts — preflight, vault pick, seed, vc login (Task 13)
// Non-interactive path: pass vault dir as first positional arg or via VOID_OS_VAULT env.
// Interactive fallback: readline menu (requires a TTY).
import { mkdirSync, cpSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkPrereqs, realDeps } from "./preflight.ts";
import { writeConfig, readConfig } from "./paths.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Seed vault floor: directory structure + files from templates + catalog. */
export function seedVault(vault: string): void {
  mkdirSync(join(vault, ".claude", "skills"), { recursive: true });
  mkdirSync(join(vault, ".claude", "agents"), { recursive: true });
  mkdirSync(join(vault, "sessions"), { recursive: true });

  const tmpl = join(repoRoot, "templates", "CLAUDE.md");
  if (existsSync(tmpl)) {
    copyFileSync(tmpl, join(vault, "CLAUDE.md"));
  }

  const onboardingSkill = join(repoRoot, "catalog", "skills", "onboarding");
  if (existsSync(onboardingSkill)) {
    cpSync(onboardingSkill, join(vault, ".claude", "skills", "onboarding"), { recursive: true });
  }

  const agentsDir = join(repoRoot, "catalog", "agents");
  if (existsSync(agentsDir)) {
    cpSync(agentsDir, join(vault, ".claude", "agents"), { recursive: true });
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

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const def = join(env.HOME ?? "/tmp", "void-os");
  const answer = (
    await rl.question(
      `vault folder?\n  [1] default (${def})\n  [2] current dir (${process.cwd()})\n  [3] custom\n> `,
    )
  ).trim();
  let vault = def;
  if (answer === "2") vault = process.cwd();
  else if (answer === "3") vault = (await rl.question("path: ")).trim();
  rl.close();
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
