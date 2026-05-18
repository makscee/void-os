import { homedir } from "node:os"
import { join, isAbsolute } from "node:path"
import type { Prompter } from "./prompter"
import type { PreflightReport } from "./preflight"
import { FlagsError } from "../init"

export interface GhDecision {
  push: boolean
  repoName?: string
}

export interface Decisions {
  vaultPath: string
  gh: GhDecision
  obsidianVaultName?: string
  cancelled: boolean
}

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

export async function configure(report: PreflightReport, prompter: Prompter): Promise<Decisions> {
  prompter.intro("void-os init")

  const rawPath = await prompter.text({
    message: "vault location?",
    defaultValue: "~/vault",
    validate: (v) => {
      if (!v) return "required"
      if (!v.startsWith("~") && !isAbsolute(v)) return "must be absolute or ~-prefixed"
    },
  })
  const vaultPath = expandHome(rawPath)

  let gh: GhDecision = { push: false }
  if (report.gh.found && report.gh.authed) {
    const push = await prompter.confirm({
      message: "create private GitHub repo and push initial commit?",
      initialValue: true,
    })
    if (push) {
      const repoName = await prompter.text({
        message: "repo name?",
        defaultValue: "vault",
        validate: (v) => (/^[a-zA-Z0-9._-]+$/.test(v) ? undefined : "invalid repo name"),
      })
      gh = { push: true, repoName }
    }
  }

  let obsidianVaultName: string | undefined
  if (report.obsidian.found) {
    obsidianVaultName = await prompter.text({
      message: "obsidian vault display name?",
      defaultValue: "void",
    })
  }

  prompter.outro(
    `vault: ${vaultPath}` +
    (gh.push ? ` · gh: ${gh.repoName}` : "") +
    (obsidianVaultName ? ` · obsidian: ${obsidianVaultName}` : ""),
  )

  const proceed = await prompter.confirm({ message: "proceed with these settings?", initialValue: true })

  return {
    vaultPath,
    gh,
    obsidianVaultName,
    cancelled: !proceed,
  }
}

export interface NonInteractiveFlags {
  nonInteractive: boolean
  vault?: string
  ghRepo?: string
  skipGh: boolean
  skipObsidian: boolean
  obsidianVault?: string
}

export function decideFromFlags(
  report: PreflightReport,
  flags: NonInteractiveFlags,
): Decisions {
  if (!flags.vault) {
    throw new FlagsError("--non-interactive requires --vault <path>", 64)
  }
  const vaultPath = expandHome(flags.vault)

  let gh: GhDecision = { push: false }
  if (flags.skipGh) {
    gh = { push: false }
  } else if (flags.ghRepo) {
    if (!report.gh.found || !report.gh.authed) {
      throw new FlagsError(
        "gh not available (not installed or not authed); remove --gh-repo or fix gh first",
        65,
      )
    }
    gh = { push: true, repoName: flags.ghRepo }
  }

  let obsidianVaultName: string | undefined
  if (!flags.skipObsidian) {
    obsidianVaultName = flags.obsidianVault
      ?? (report.obsidian.found ? "void" : undefined)
  }

  return { vaultPath, gh, obsidianVaultName, cancelled: false }
}
