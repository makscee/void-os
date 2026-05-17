import {
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  statSync,
  symlinkSync,
  cpSync,
} from "node:fs"
import { join, dirname } from "node:path"

export interface ProvisionOpts {
  home: string
  prefix: string
  dryRun: boolean
  force: boolean
}

export interface ProvisionResult {
  copied: string[]
  skipped: string[]
  warnings: string[]
}

const VOID_MARKER = ".void"

export async function provision(opts: ProvisionOpts): Promise<ProvisionResult> {
  const { home, prefix, dryRun, force } = opts
  const result: ProvisionResult = { copied: [], skipped: [], warnings: [] }

  const isUpgrade = existsSync(join(home, VOID_MARKER))
  const isEmpty = !existsSync(home) || readdirSync(home).length === 0
  if (existsSync(home) && !isEmpty && !isUpgrade && !force) {
    throw new Error(
      `refusing to clobber non-void dir at ${home}; use --force to override`,
    )
  }

  if (!existsSync(home) && !dryRun) mkdirSync(home, { recursive: true })

  const starter = join(prefix, "starter-vault")
  copyTree(starter, home, { dryRun, force, isUpgrade }, result)

  ensureClaudeSkillsSymlink(home, { dryRun }, result)

  copyPluginDist(prefix, home, { dryRun }, result)

  return result
}

function copyTree(
  src: string,
  dst: string,
  opts: { dryRun: boolean; force: boolean; isUpgrade: boolean },
  result: ProvisionResult,
) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) {
      if (!existsSync(d) && !opts.dryRun) mkdirSync(d, { recursive: true })
      copyTree(s, d, opts, result)
    } else {
      const exists = existsSync(d)
      if (exists && !opts.force) {
        result.skipped.push(d)
        continue
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(d), { recursive: true })
        copyFileSync(s, d)
      }
      result.copied.push(d)
    }
  }
}

function ensureClaudeSkillsSymlink(
  home: string,
  opts: { dryRun: boolean },
  result: ProvisionResult,
) {
  const claudeDir = join(home, ".claude")
  const link = join(claudeDir, "skills")
  if (existsSync(link)) {
    result.skipped.push(link)
    return
  }
  if (!opts.dryRun) {
    mkdirSync(claudeDir, { recursive: true })
    symlinkSync("../skills", link, "dir")
  }
  result.copied.push(link)
}

function copyPluginDist(
  prefix: string,
  home: string,
  opts: { dryRun: boolean },
  result: ProvisionResult,
) {
  const src = join(prefix, "plugin/dist")
  const dst = join(home, ".obsidian/plugins/void-os")
  if (!existsSync(src)) {
    result.warnings.push(
      `plugin build artifact missing at ${src}; vault will open in Obsidian without the void-os plugin`,
    )
    return
  }
  if (!opts.dryRun) cpSync(src, dst, { recursive: true, force: true })
  result.copied.push(dst)
}

export default async function cli(args: string[], ctx: { prefix: string }) {
  const flags = parseFlags(args)
  const home = flags.home ?? process.env.VOID_HOME ?? join(process.env.HOME!, "void")
  const result = await provision({
    home,
    prefix: ctx.prefix,
    dryRun: flags.dryRun,
    force: flags.force,
  })
  for (const w of result.warnings) console.warn(`warning: ${w}`)
  console.log(`vault ready at ${home}`)
  console.log(`next:`)
  console.log(`  brew services start void-os`)
  console.log(`  open ${home}`)
}

function parseFlags(args: string[]): {
  home?: string
  dryRun: boolean
  force: boolean
} {
  const out = { home: undefined as string | undefined, dryRun: false, force: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--force") out.force = true
    else if (a === "--home") out.home = args[++i]
    else throw new Error(`unknown flag: ${a}`)
  }
  return out
}
