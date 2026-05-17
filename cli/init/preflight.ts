import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface PreflightReport {
  os: "darwin" | "linux" | "unknown"
  claude: { found: boolean; version?: string }
  bun: { found: boolean; version?: string }
  gh: { found: boolean; authed: boolean }
  obsidian: { found: boolean }
}

export interface PreflightDeps {
  whichSync: (cmd: string) => string | null
  fileExists: (path: string) => boolean
  runSync: (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string }
  platform: NodeJS.Platform
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
}

export function detect(deps: PreflightDeps = defaultDeps): PreflightReport {
  const os: PreflightReport["os"] =
    deps.platform === "darwin" ? "darwin" :
    deps.platform === "linux" ? "linux" : "unknown"

  const claudeBin = deps.whichSync("claude")
  const bunBin = deps.whichSync("bun")
  const ghBin = deps.whichSync("gh")

  let ghAuthed = false
  if (ghBin) {
    ghAuthed = deps.runSync("gh", ["auth", "status"]).status === 0
  }

  const obsidianFound =
    os === "darwin" ? deps.fileExists("/Applications/Obsidian.app") :
    os === "linux" ? (deps.whichSync("obsidian") !== null || deps.fileExists(join(homedir(), ".config/Obsidian"))) :
    false

  return {
    os,
    claude: { found: !!claudeBin },
    bun: { found: !!bunBin },
    gh: { found: !!ghBin, authed: ghAuthed },
    obsidian: { found: obsidianFound },
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
}
