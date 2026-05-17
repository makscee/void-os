import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seed } from "./seed"

let tmpRoot: string
let prefix: string
let home: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vos119-seed-"))
  prefix = join(tmpRoot, "prefix")
  home = join(tmpRoot, "home")
  mkdirSync(join(prefix, "starter-vault/agents/tinker"), { recursive: true })
  mkdirSync(join(prefix, "starter-vault/skills"), { recursive: true })
  writeFileSync(join(prefix, "starter-vault/CLAUDE.md"), "# claude\n")
  writeFileSync(join(prefix, "starter-vault/log.md"), "")
  writeFileSync(join(prefix, "starter-vault/README.md"), "# vault\n")
  writeFileSync(join(prefix, "starter-vault/agents/tinker/agent.md"), "tinker\n")
  writeFileSync(join(prefix, "starter-vault/skills/.gitkeep"), "")
})

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe("seed() fresh install", () => {
  it("creates vault dir, copies tree, writes .void marker, runs git init + first commit", async () => {
    const r = await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, "agents/tinker/agent.md"))).toBe(true)
    expect(existsSync(join(home, ".void"))).toBe(true)
    expect(statSync(join(home, ".void")).isFile()).toBe(true)
    const marker = JSON.parse(readFileSync(join(home, ".void"), "utf8"))
    expect(marker.version).toBe(1)
    expect(typeof marker.createdAt).toBe("string")
    expect(marker.vault).toBeUndefined()
    expect(existsSync(join(home, ".git"))).toBe(true)
    const log = spawnSync("git", ["-C", home, "log", "--oneline"], { encoding: "utf8" })
    expect(log.stdout).toMatch(/seed: void-os init/)
    expect(r.isFreshSeed).toBe(true)
  })
})

describe("seed() re-run idempotency", () => {
  it("skips file copy + git init + commit on re-run without --force, leaves marker untouched", async () => {
    await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    const markerBefore = readFileSync(join(home, ".void"), "utf8")
    const markerMtimeBefore = statSync(join(home, ".void")).mtimeMs
    writeFileSync(join(home, "CLAUDE.md"), "USER EDITED\n")
    writeFileSync(join(home, "scratch.md"), "user note\n")

    await new Promise((r) => setTimeout(r, 50))

    const r = await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("USER EDITED\n")
    expect(r.isFreshSeed).toBe(false)
    expect(readFileSync(join(home, ".void"), "utf8")).toBe(markerBefore)
    expect(statSync(join(home, ".void")).mtimeMs).toBe(markerMtimeBefore)

    const log = spawnSync("git", ["-C", home, "log", "--oneline"], { encoding: "utf8" })
    const commits = log.stdout.trim().split("\n").filter(Boolean)
    expect(commits.length).toBe(1)
  })

  it("rewrites marker when existing file is unparseable (corrupted)", async () => {
    await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    writeFileSync(join(home, ".void"), "not json garbage")
    await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    const j = JSON.parse(readFileSync(join(home, ".void"), "utf8"))
    expect(j.version).toBe(1)
  })

  it("with --force, overwrites seed files but still skips git init + commit", async () => {
    await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    writeFileSync(join(home, "CLAUDE.md"), "USER EDITED\n")

    const r = await seed({ home, prefix, dryRun: false, force: true, gh: { push: false } })
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("# claude\n")
    expect(r.isFreshSeed).toBe(false)
    const log = spawnSync("git", ["-C", home, "log", "--oneline"], { encoding: "utf8" })
    const commits = log.stdout.trim().split("\n").filter(Boolean)
    expect(commits.length).toBe(1)
  })
})

describe("seed() refuse clobber", () => {
  it("throws on non-empty dir without marker and without --force", async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "stranger.md"), "not ours")
    await expect(
      seed({ home, prefix, dryRun: false, force: false, gh: { push: false } }),
    ).rejects.toThrow(/refusing to clobber/)
  })
})

describe("seed() reuses pre-existing .git instead of re-initializing", () => {
  it("does not re-run git init when .git already exists in target", async () => {
    let initCalls = 0
    const fakeSpawn: any = (cmd: string, args: string[], opts: any) => {
      if (cmd === "git" && args.includes("init")) initCalls++
      return spawnSync(cmd, args, opts)
    }
    mkdirSync(home, { recursive: true })
    const pre = spawnSync("git", ["-C", home, "init", "-b", "main"])
    expect(pre.status).toBe(0)

    // .git makes home non-empty -> force required to seed into it
    const r = await seed({
      home,
      prefix,
      dryRun: false,
      force: true,
      gh: { push: false },
      spawnSync: fakeSpawn,
    })
    expect(r.isFreshSeed).toBe(true)
    expect(initCalls).toBe(0) // pre-existing .git -> no re-init
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, ".void"))).toBe(true)
  })
})

describe("seed() gh remote safety", () => {
  it("refuses gh push when origin already points at a different repo", async () => {
    const calls: string[][] = []
    const fakeSpawn: any = (cmd: string, args: string[], opts: any) => {
      calls.push([cmd, ...args])
      if (cmd === "git" && args.includes("remote") && args.includes("get-url")) {
        return { status: 0, stdout: "git@github.com:other/repo.git\n", stderr: "" } as any
      }
      if (cmd === "gh") {
        if (args[0] === "repo" && args[1] === "view") {
          return { status: 0, stdout: "git@github.com:me/vault.git\n", stderr: "" } as any
        }
        return { status: 0, stdout: "", stderr: "" } as any
      }
      return spawnSync(cmd, args, opts)
    }

    const r = await seed({
      home,
      prefix,
      dryRun: false,
      force: false,
      gh: { push: true, repoName: "me/vault" },
      spawnSync: fakeSpawn,
    })
    expect(r.gh.pushed).toBe(false)
    expect(r.gh.warning).toBe("remote-mismatch")
    expect(r.warnings.some((w) => /origin already set/i.test(w))).toBe(true)
    expect(
      calls.some((c) => c[0] === "gh" && c[1] === "repo" && c[2] === "create"),
    ).toBe(false)
  })

  it("skips gh push when origin exists but target repo cannot be verified via gh repo view", async () => {
    const calls: string[][] = []
    const fakeSpawn: any = (cmd: string, args: string[], opts: any) => {
      calls.push([cmd, ...args])
      if (cmd === "git" && args.includes("remote") && args.includes("get-url")) {
        return { status: 0, stdout: "git@github.com:other/repo.git\n", stderr: "" } as any
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { status: 1, stdout: "", stderr: "not found" } as any
      }
      if (cmd === "git" && args.includes("push")) {
        return { status: 0, stdout: "", stderr: "" } as any
      }
      return spawnSync(cmd, args, opts)
    }

    const r = await seed({
      home,
      prefix,
      dryRun: false,
      force: false,
      gh: { push: true, repoName: "me/vault" },
      spawnSync: fakeSpawn,
    })
    expect(r.gh.pushed).toBe(false)
    expect(r.gh.warning).toBe("remote-unverifiable")
    expect(calls.some((c) => c[0] === "git" && c.includes("push"))).toBe(false)
  })
})
