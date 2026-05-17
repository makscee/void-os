import {
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  writeFileSync,
  renameSync,
  readFileSync,
  statSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { join, dirname } from "node:path"

const VOID_MARKER = ".void"

export interface SeedOpts {
  home: string
  prefix: string
  dryRun: boolean
  force: boolean
  gh: { push: boolean; repoName?: string }
  spawnSync?: typeof spawnSync
}

export interface SeedResult {
  copied: string[]
  skipped: string[]
  warnings: string[]
  isFreshSeed: boolean
  gh: { pushed: boolean; remote?: string; warning?: string }
}

export async function seed(opts: SeedOpts): Promise<SeedResult> {
  const { home, prefix, dryRun, force } = opts
  const spawn = opts.spawnSync ?? spawnSync
  const result: SeedResult = {
    copied: [],
    skipped: [],
    warnings: [],
    isFreshSeed: false,
    gh: { pushed: false },
  }

  const markerPath = join(home, VOID_MARKER)
  const markerPresent =
    existsSync(markerPath) && statSync(markerPath).isFile()
  const dirEmpty = !existsSync(home) || readdirSync(home).length === 0

  if (existsSync(home) && !dirEmpty && !markerPresent && !force) {
    throw new Error(
      `refusing to clobber non-void dir at ${home}; use --force to override`,
    )
  }

  result.isFreshSeed = !markerPresent

  if (!existsSync(home) && !dryRun) mkdirSync(home, { recursive: true })

  // 1. git init -- only on fresh seed AND only if no .git already exists
  if (result.isFreshSeed && !existsSync(join(home, ".git")) && !dryRun) {
    const r = spawn("git", ["-C", home, "init", "-b", "main"], {
      stdio: "inherit",
    })
    if (r.status !== 0) throw new Error("git init failed")
  }

  // 2. Copy starter-vault tree
  if (result.isFreshSeed || force) {
    const starter = join(prefix, "starter-vault")
    if (existsSync(starter)) {
      copyTree(starter, home, { dryRun, force }, result)
    }
  } else {
    result.skipped.push("starter-vault copy (re-run, no --force)")
  }

  // 3. .claude/skills symlink
  ensureClaudeSkillsSymlink(home, { dryRun }, result)

  // 4. Marker write -- only on fresh seed OR if existing marker is unparseable.
  if (!dryRun) {
    const needsWrite = result.isFreshSeed || !parseableMarker(markerPath)
    if (needsWrite) {
      const marker = { version: 1, createdAt: new Date().toISOString() }
      const tmp = join(home, `${VOID_MARKER}.tmp`)
      writeFileSync(tmp, JSON.stringify(marker, null, 2))
      renameSync(tmp, markerPath)
      result.copied.push(markerPath)
    } else {
      result.skipped.push(markerPath)
    }
  }

  // 5. First commit -- only on fresh seed
  if (result.isFreshSeed && !dryRun) {
    spawn("git", ["-C", home, "add", "-A"], { stdio: "inherit" })
    const r = spawn(
      "git",
      [
        "-C",
        home,
        "-c",
        "user.email=void-os@local",
        "-c",
        "user.name=void-os",
        "commit",
        "-m",
        "seed: void-os init",
      ],
      { stdio: "inherit" },
    )
    if (r.status !== 0) {
      result.warnings.push("git commit failed (possibly empty tree)")
    }
  }

  // 6. GH push (optional, never auto-rewrite an existing foreign origin)
  if (opts.gh.push && opts.gh.repoName && !dryRun) {
    runGhPush(home, opts.gh.repoName, spawn, result)
  }

  return result
}

function parseableMarker(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const j = JSON.parse(readFileSync(path, "utf8"))
    return (
      typeof j === "object" &&
      j !== null &&
      j.version === 1 &&
      typeof j.createdAt === "string"
    )
  } catch {
    return false
  }
}

function copyTree(
  src: string,
  dst: string,
  opts: { dryRun: boolean; force: boolean },
  result: SeedResult,
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
  result: SeedResult,
) {
  const claudeDir = join(home, ".claude")
  const link = join(claudeDir, "skills")
  if (existsSync(link)) {
    result.skipped.push(link)
    return
  }
  if (!opts.dryRun) {
    mkdirSync(claudeDir, { recursive: true })
    try {
      symlinkSync("../skills", link, "dir")
    } catch (e) {
      result.warnings.push(`skills symlink failed: ${(e as Error).message}`)
      return
    }
  }
  result.copied.push(link)
}

function runGhPush(
  home: string,
  repoName: string,
  spawn: typeof spawnSync,
  result: SeedResult,
) {
  const existing = spawn("git", ["-C", home, "remote", "get-url", "origin"], {
    encoding: "utf8",
  })
  const targetCheck = spawn(
    "gh",
    ["repo", "view", repoName, "--json", "sshUrl,url", "-q", ".sshUrl"],
    { encoding: "utf8" },
  )
  const targetUrl =
    targetCheck.status === 0
      ? ((targetCheck.stdout as unknown as string) ?? "").trim()
      : null

  if (existing.status === 0) {
    const have = ((existing.stdout as unknown as string) ?? "").trim()
    if (targetUrl && have !== targetUrl) {
      result.warnings.push(
        `gh push skipped: origin already set to ${have}; target was ${targetUrl}. Resolve manually.`,
      )
      result.gh.warning = "remote-mismatch"
      return
    }
    const push = spawn(
      "git",
      ["-C", home, "push", "-u", "origin", "main"],
      { stdio: "inherit" },
    )
    if (push.status === 0) {
      result.gh.pushed = true
      result.gh.remote = have
    } else {
      result.warnings.push("git push failed; local repo intact")
      result.gh.warning = "push-failed"
    }
    return
  }

  const create = spawn(
    "gh",
    ["repo", "create", repoName, "--private", "--source", home, "--push"],
    { stdio: "inherit" },
  )
  if (create.status === 0) {
    result.gh.pushed = true
    const after = spawn(
      "git",
      ["-C", home, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    )
    if (after.status === 0) {
      result.gh.remote = ((after.stdout as unknown as string) ?? "").trim()
    }
    return
  }

  if (targetUrl) {
    spawn("git", ["-C", home, "remote", "add", "origin", targetUrl], {
      stdio: "inherit",
    })
    const push = spawn(
      "git",
      ["-C", home, "push", "-u", "origin", "main"],
      { stdio: "inherit" },
    )
    if (push.status === 0) {
      result.gh.pushed = true
      result.gh.remote = targetUrl
      return
    }
  }
  result.warnings.push("gh repo create + push failed; local repo intact")
  result.gh.warning = "create-failed"
}
