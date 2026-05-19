import { homedir } from "node:os"
import { join, isAbsolute, dirname } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { cwd } from "node:process"
import type { Prompter, SelectOption } from "./prompter"
import type { PreflightReport } from "./preflight"
import { FlagsError } from "../init"

export interface GhDecision {
  push: boolean
  repoName?: string
}

export interface Decisions {
  vaultPath: string
  gh: GhDecision
  cancelled: boolean
}

export interface ConfigureDeps {
  isInsideVoidOsRepo?: (path: string) => boolean
}

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function defaultIsInsideVoidOsRepo(path: string): boolean {
  let dir = path
  while (true) {
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
        if (pkg.name === "void-os") return true
      } catch {
        /* malformed; ignore */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

export async function configure(
  report: PreflightReport,
  prompter: Prompter,
  deps: ConfigureDeps = {},
): Promise<Decisions> {
  const isInsideVoidOsRepo = deps.isInsideVoidOsRepo ?? defaultIsInsideVoidOsRepo
  prompter.intro("void-os init")

  const pwdInRepo = isInsideVoidOsRepo(cwd())
  const candidates: SelectOption<string>[] = [
    {
      value: cwd(),
      label: pwdInRepo
        ? `current folder (${cwd()}) — inside void-os clone, not allowed`
        : `current folder (${cwd()})`,
    },
    { value: join(homedir(), "void-os-vault"), label: "~/void-os-vault" },
    { value: join(homedir(), "vault"), label: "~/vault" },
    { value: "__custom__", label: "enter custom path" },
  ]

  const picked = await prompter.select<string>({
    message: "vault location?",
    options: candidates,
    initialValue: pwdInRepo ? candidates[1].value : candidates[0].value,
  })

  if (picked === cwd() && pwdInRepo) {
    throw new FlagsError(`Refusing to seed inside the void-os clone at ${cwd()}.`, 2)
  }

  let vaultPath: string
  if (picked === "__custom__") {
    const raw = await prompter.text({
      message: "vault path?",
      placeholder: "~/some/dir",
      validate: (v) => {
        if (!v) return "required"
        if (!v.startsWith("~") && !isAbsolute(v)) return "must be absolute or ~-prefixed"
        const expanded = expandHome(v)
        if (isInsideVoidOsRepo(expanded)) return "cannot seed inside the void-os clone"
      },
    })
    vaultPath = expandHome(raw)
  } else {
    vaultPath = picked
  }

  let gh: GhDecision = { push: false }
  if (report.gh.found && report.gh.authed) {
    const push = await prompter.confirm({
      message: "create private GitHub repo and push initial commit?",
      initialValue: false,
    })
    if (push) {
      const repoName = await prompter.text({
        message: "repo name?",
        defaultValue: "vault",
        placeholder: "vault",
        validate: (v) => (/^[a-zA-Z0-9._-]+$/.test(v) ? undefined : "invalid repo name"),
      })
      gh = { push: true, repoName }
    }
  }

  prompter.outro(
    `vault: ${vaultPath}` +
    (gh.push ? ` · gh: ${gh.repoName}` : ""),
  )

  const proceed = await prompter.confirm({ message: "proceed with these settings?", initialValue: true })

  return {
    vaultPath,
    gh,
    cancelled: !proceed,
  }
}

export interface NonInteractiveFlags {
  nonInteractive: boolean
  vault?: string
  ghRepo?: string
  skipGh: boolean
}

export function decideFromFlags(
  report: PreflightReport,
  flags: NonInteractiveFlags,
  deps: ConfigureDeps = {},
): Decisions {
  const isInsideVoidOsRepo = deps.isInsideVoidOsRepo ?? defaultIsInsideVoidOsRepo
  if (!flags.vault) {
    throw new FlagsError("--non-interactive requires --vault <path>", 64)
  }
  const vaultPath = expandHome(flags.vault)

  if (isInsideVoidOsRepo(vaultPath)) {
    throw new FlagsError(`Refusing to seed inside the void-os clone at ${vaultPath}.`, 2)
  }

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

  return { vaultPath, gh, cancelled: false }
}
