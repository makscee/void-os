import { readSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { detect, enforce, PreflightError, type PreflightReport } from "./init/preflight"
import { ClackPrompter, type Prompter } from "./init/prompter"
import { configure, decideFromFlags } from "./init/configure"
import type { Decisions } from "./init/configure"
import { runBuild, BuildError } from "./init/build"
import { seed } from "./init/seed"
import { installPlugin, ensurePluginBuilt } from "./init/plugin"
import { formatReport } from "./init/report"
import {
  promptObsidian as obsidianHelper,
  printNextSteps as nextStepsHelper,
} from "./init/obsidian"

// Re-export for backwards compatibility with existing tests + external callers.
export { seed as provision } from "./init/seed"
export type { SeedOpts as ProvisionOpts, SeedResult as ProvisionResult } from "./init/seed"

export interface Flags {
  home?: string
  dryRun: boolean
  force: boolean
  skipBuild: boolean
  nonInteractive: boolean
  vault?: string
  ghRepo?: string
  skipGh: boolean
  skipObsidian: boolean
  obsidianVault?: string
}

export class FlagsError extends Error {
  constructor(msg: string, public exitCode: number) { super(msg) }
}

export function validateFlags(f: Flags): void {
  if (f.nonInteractive && !f.vault) {
    throw new FlagsError("--non-interactive requires --vault <path>", 64)
  }
  if (f.ghRepo && f.skipGh) {
    throw new FlagsError("--gh-repo and --skip-gh are mutually exclusive", 64)
  }
  if (f.obsidianVault && f.skipObsidian) {
    throw new FlagsError("--obsidian-vault and --skip-obsidian are mutually exclusive", 64)
  }
}

export function parseFlags(args: string[]): Flags {
  const out: Flags = {
    dryRun: false, force: false, skipBuild: false,
    nonInteractive: false, skipGh: false, skipObsidian: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--force") out.force = true
    else if (a === "--skip-build") out.skipBuild = true
    else if (a === "--home") out.home = args[++i]
    else if (a === "--non-interactive") out.nonInteractive = true
    else if (a === "--vault") out.vault = args[++i]
    else if (a === "--gh-repo") out.ghRepo = args[++i]
    else if (a === "--skip-gh") out.skipGh = true
    else if (a === "--skip-obsidian") out.skipObsidian = true
    else if (a === "--obsidian-vault") out.obsidianVault = args[++i]
    else throw new Error(`unknown flag: ${a}`)
  }
  return out
}

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function defaultBrewPrompt(): boolean {
  process.stderr.write("bun is required. Run `brew install bun`? [y/N] ")
  const buf = Buffer.alloc(8)
  try {
    const n = readSync(0, buf, 0, 8, null)
    return /^y/i.test(buf.slice(0, n).toString().trim())
  } catch {
    return false
  }
}

export interface InitCommandOpts {
  args: string[]
  prefix: string
  /** Override the Prompter implementation (testing). */
  prompter?: Prompter
  /** Override the brew-install-bun confirmation (testing). */
  offerBrewInstallBun?: () => boolean
  /** Inject a fake preflight report (testing); skips real detect()/enforce(). */
  preflight?: PreflightReport
  /** Skip the build phase entirely (testing convenience; equivalent to --skip-build). */
  skipBuild?: boolean
  /** Test seam: override the Obsidian prompt at end of init. */
  promptObsidian?: (opts: { vault: string; prompter: Prompter; interactive: boolean }) => Promise<void>
  /** Test seam: override the next-steps banner. */
  printNextSteps?: (opts: { vault: string }) => void
}

async function defaultPromptObsidian(o: { vault: string; prompter: Prompter; interactive: boolean }): Promise<void> {
  await obsidianHelper({ vault: o.vault, prompter: o.prompter, interactive: o.interactive })
}

function defaultPrintNextSteps(o: { vault: string }): void {
  nextStepsHelper({ vault: o.vault })
}

/**
 * Phase orchestrator. Wires preflight → configure → build → seed → plugin → report.
 *
 * Returns nothing on success; throws (or calls process.exit) on hard failure.
 */
export async function initCommand(opts: InitCommandOpts): Promise<void> {
  const flags = parseFlags(opts.args)
  try {
    validateFlags(flags)
  } catch (e) {
    if (e instanceof FlagsError) {
      console.error(e.message)
      process.exit(e.exitCode)
      return
    }
    throw e
  }
  const prompter: Prompter = opts.prompter ?? new ClackPrompter()

  // 1. PREFLIGHT (skipped when an injected report is supplied)
  let report: PreflightReport
  if (opts.preflight) {
    report = opts.preflight
  } else {
    report = detect()
    const offerBrewInstallBun = flags.nonInteractive
      ? () => false
      : (opts.offerBrewInstallBun ?? defaultBrewPrompt)
    try {
      enforce(report, { offerBrewInstallBun })
    } catch (e) {
      if (e instanceof PreflightError) {
        console.error(`preflight: ${e.message}`)
        process.exit(e.exitCode)
      }
      throw e
    }
  }

  // 2. CONFIGURE
  let decisions: Decisions
  if (flags.nonInteractive) {
    try {
      decisions = decideFromFlags(report, flags)
    } catch (e) {
      if (e instanceof FlagsError) {
        console.error(e.message)
        process.exit(e.exitCode)
        return
      }
      throw e
    }
  } else {
    decisions = await configure(report, prompter)
    if (decisions.cancelled) {
      console.error("cancelled")
      process.exit(130)
      return
    }
  }

  const vaultPath = flags.home
    ? expandHome(flags.home)
    : decisions.vaultPath

  // 3. BUILD
  try {
    runBuild({ prefix: opts.prefix, skipBuild: flags.skipBuild || !!opts.skipBuild })
  } catch (e) {
    if (e instanceof BuildError) {
      console.error(`build: ${e.message}`)
      process.exit(e.exitCode)
    }
    throw e
  }

  // 4. SEED
  let seedResult
  try {
    seedResult = await seed({
      home: vaultPath,
      prefix: opts.prefix,
      dryRun: flags.dryRun,
      force: flags.force,
      gh: decisions.gh,
    })
  } catch (e) {
    console.error(`seed: ${(e as Error).message}`)
    process.exit(4)
    return
  }

  // 5. PLUGIN
  // Auto-build plugin/dist if missing (fresh clone has no built artifact).
  // Mirrors scripts/fresh-vault.sh. Surface stdout/stderr only on failure.
  const buildResult = ensurePluginBuilt({ prefix: opts.prefix, dryRun: flags.dryRun })
  if (buildResult.ran && !buildResult.built && buildResult.error) {
    console.warn(`warning: plugin pre-build failed: ${buildResult.error}`)
  }
  const pluginResult = installPlugin({
    prefix: opts.prefix,
    home: vaultPath,
    dryRun: flags.dryRun,
  })

  // 6. REPORT
  for (const w of seedResult.warnings) console.warn(`warning: ${w}`)
  for (const w of pluginResult.warnings) console.warn(`warning: ${w}`)
  console.log(formatReport({
    vaultPath,
    preflight: report,
    decisions,
    seed: seedResult,
    plugin: pluginResult,
  }))

  // 7. PROMPT OBSIDIAN — offer to open the seeded vault in Obsidian (macOS only when interactive).
  // Errors propagate (matches the configure() pattern): Ctrl-C from the prompter exits 130 via
  // ClackPrompter.cancel(), and tests' PrompterCancelled bubbles past printNextSteps.
  if (!flags.dryRun) {
    const promptObs = opts.promptObsidian ?? defaultPromptObsidian
    await promptObs({ vault: vaultPath, prompter, interactive: !flags.nonInteractive })
  }

  // 8. NEXT STEPS — print operator banner ("chat in Obsidian / chat in CLI").
  if (!flags.dryRun) {
    const nextSteps = opts.printNextSteps ?? defaultPrintNextSteps
    nextSteps({ vault: vaultPath })
  }
}

export default async function cli(args: string[], ctx: { prefix: string }) {
  await initCommand({ args, prefix: ctx.prefix })
}
