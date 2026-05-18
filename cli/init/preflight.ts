import { spawnSync } from "node:child_process"
import { existsSync, accessSync, constants as fsConstants } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface ClaudevDetection {
  found: boolean
  path?: string
  source?: "env" | "path"
}

export interface PreflightReport {
  os: "darwin" | "linux" | "unknown"
  claude: { found: boolean; version?: string }
  bun: { found: boolean; version?: string }
  gh: { found: boolean; authed: boolean }
  obsidian: { found: boolean }
  claudev: ClaudevDetection
}

export interface PreflightDeps {
  whichSync: (cmd: string) => string | null
  fileExists: (path: string) => boolean
  runSync: (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string }
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}

const defaultDeps: PreflightDeps = {
  whichSync: (cmd) => {
    const r = spawnSync("which", [cmd], { encoding: "utf8" })
    return r.status === 0 ? r.stdout.trim() : null
  },
  fileExists: existsSync,
  runSync: (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" })
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  },
  platform: process.platform,
  env: process.env,
}

function isExecutable(p: string): boolean {
  try { accessSync(p, fsConstants.X_OK); return true } catch { return false }
}

export function detectClaudev(env: NodeJS.ProcessEnv = process.env): ClaudevDetection {
  const fromEnv = env.VOID_OS_CC_BIN
  if (fromEnv && existsSync(fromEnv) && isExecutable(fromEnv)) {
    return { found: true, path: fromEnv, source: "env" }
  }
  const paths = (env.PATH ?? "").split(":").filter(Boolean)
  for (const dir of paths) {
    const candidate = join(dir, "claudev")
    if (existsSync(candidate) && isExecutable(candidate)) {
      return { found: true, path: candidate, source: "path" }
    }
  }
  return { found: false }
}

export function detect(deps: Partial<PreflightDeps> = {}): PreflightReport {
  const d: PreflightDeps = { ...defaultDeps, ...deps }
  const os: PreflightReport["os"] =
    d.platform === "darwin" ? "darwin" :
    d.platform === "linux" ? "linux" : "unknown"

  const claudeBin = d.whichSync("claude")
  const bunBin = d.whichSync("bun")
  const ghBin = d.whichSync("gh")

  let ghAuthed = false
  if (ghBin) {
    ghAuthed = d.runSync("gh", ["auth", "status"]).status === 0
  }

  const obsidianFound =
    os === "darwin" ? d.fileExists("/Applications/Obsidian.app") :
    os === "linux" ? (d.whichSync("obsidian") !== null || d.fileExists(join(homedir(), ".config/Obsidian"))) :
    false

  return {
    os,
    claude: { found: !!claudeBin },
    bun: { found: !!bunBin },
    gh: { found: !!ghBin, authed: ghAuthed },
    obsidian: { found: obsidianFound },
    claudev: detectClaudev(d.env),
  }
}

export class PreflightError extends Error {
  constructor(msg: string, public exitCode = 2) { super(msg) }
}

export function enforce(report: PreflightReport, opts: { offerBrewInstallBun?: () => boolean }) {
  if (!report.claude.found) {
    throw new PreflightError(
      "claude CLI not found. Install: https://docs.claude.com/en/docs/claude-code/quickstart",
    )
  }
  if (!report.bun.found) {
    if (report.os === "darwin" && opts.offerBrewInstallBun && opts.offerBrewInstallBun()) {
      const r = spawnSync("brew", ["install", "bun"], { stdio: "inherit" })
      if (r.status !== 0) {
        throw new PreflightError("brew install bun failed")
      }
    } else if (report.os === "linux") {
      throw new PreflightError("bun not found. Install: https://bun.sh/install")
    } else {
      throw new PreflightError("bun not found")
    }
  }
  if (!report.claudev?.found) {
    throw new PreflightError(
      "claudev not found. Set VOID_OS_CC_BIN=/abs/path/to/claudev or add claudev to PATH. See: https://github.com/makscee/claudev",
      2,
    )
  }
}
