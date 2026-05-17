import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  cpSync,
  readFileSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { initCommand } from "./init"
import { ScriptedPrompter } from "./init/prompter"
import type { PreflightReport } from "./init/preflight"

// Full end-to-end test: treats initCommand as a black box, exercising
// preflight (injected) → configure (Scripted) → build (skipped) → seed (real)
// → plugin (real) → report against a real temp directory. Asserts the
// user-visible outcome: filesystem state, byte-identical starter copies,
// marker shape, git history, and report content.

// Resolve the real void-os repo root so we can copy the real starter-vault
// into the test prefix. The test file lives at <repo>/cli/init.e2e.test.ts.
const REPO_ROOT = resolve(dirname(import.meta.path), "..")
const STARTER_SRC = join(REPO_ROOT, "starter-vault")

// Files we assert are copied verbatim. Mirrors the real starter tree.
const STARTER_FILES = [
  "CLAUDE.md",
  "README.md",
  "log.md",
  "agents/tinker/agent.md",
] as const

let tmpRoot: string
let prefix: string
let home: string

// Obsidian NOT detected → plugin-install skip branch will fire via missing
// plugin/dist (we deliberately don't create it). gh false → no gh prompts.
const fakePreflight: PreflightReport = {
  os: "darwin",
  claude: { found: true },
  bun: { found: true },
  gh: { found: false, authed: false },
  obsidian: { found: false },
}

function setupPrefixWithRealStarter(): void {
  mkdirSync(prefix, { recursive: true })
  // Copy the real starter-vault verbatim so byte-comparison is meaningful.
  cpSync(STARTER_SRC, join(prefix, "starter-vault"), { recursive: true })
  // Deliberately omit plugin/dist to exercise installPlugin() skip branch.
}

function runInit(args: string[], answers: { text: string[]; confirm: boolean[] }) {
  const prompter = new ScriptedPrompter(answers)
  const logs: string[] = []
  const warns: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "))
  })
  const warnSpy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(" "))
  })
  return {
    prompter,
    logs,
    warns,
    promise: initCommand({
      args,
      prefix,
      prompter,
      preflight: fakePreflight,
      skipBuild: true,
    })
      .finally(() => {
        logSpy.mockRestore()
        warnSpy.mockRestore()
      }),
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vos119-e2e-"))
  prefix = join(tmpRoot, "prefix")
  home = join(tmpRoot, "home")
  setupPrefixWithRealStarter()
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("initCommand() — end-to-end against real fs", () => {
  it("fresh install: copies starter verbatim, writes marker, runs git init + commit, skips plugin, reports next steps", async () => {
    const run = runInit([], { text: [home], confirm: [true] })
    await run.promise

    // 1. Vault dir created at the prompted location.
    expect(existsSync(home)).toBe(true)
    expect(statSync(home).isDirectory()).toBe(true)

    // 2. All starter-vault files copied verbatim (byte-for-byte).
    for (const rel of STARTER_FILES) {
      const seeded = join(home, rel)
      const source = join(STARTER_SRC, rel)
      expect(existsSync(seeded)).toBe(true)
      const a = readFileSync(seeded)
      const b = readFileSync(source)
      expect(a.equals(b)).toBe(true)
    }

    // 3. .void/ is a directory; marker.json present, well-formed.
    expect(statSync(join(home, ".void")).isDirectory()).toBe(true)
    const markerPath = join(home, ".void/marker.json")
    expect(statSync(markerPath).isFile()).toBe(true)
    const marker = JSON.parse(readFileSync(markerPath, "utf8"))
    expect(marker.version).toBe(1)
    expect(typeof marker.createdAt).toBe("string")
    // createdAt must parse as a valid ISO timestamp.
    expect(Number.isFinite(Date.parse(marker.createdAt))).toBe(true)

    // 4. git init ran (.git dir present) + an initial commit exists.
    expect(existsSync(join(home, ".git"))).toBe(true)
    const log = Bun.spawnSync({
      cmd: ["git", "-C", home, "log", "--oneline"],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(log.exitCode).toBe(0)
    const logOut = new TextDecoder().decode(log.stdout)
    expect(logOut).toContain("seed: void-os init")

    // 5. Plugin install skipped (no plugin/dist in prefix). Verify the skip
    //    branch is exercised: no plugin files at .obsidian/plugins/void-os/.
    expect(existsSync(join(home, ".obsidian/plugins/void-os/main.js"))).toBe(false)

    // 6. Report includes next-step CLI cue. Obsidian was NOT detected, so
    //    the report uses the "install Obsidian" branch.
    const stdout = run.logs.join("\n")
    expect(stdout).toContain(`void-os seeded at ${home}`)
    expect(stdout).toContain("git initialized + first commit")
    expect(stdout).toContain("void-os ask tinker")
    expect(stdout).toContain("install Obsidian")
    expect(stdout).toContain("plugin: not installed (build artifact missing)")
  })

  it("fresh install with Obsidian detected: report includes Obsidian-specific next steps", async () => {
    // Swap preflight to obsidian-found for THIS test only by going through
    // a fresh prompter and a one-off preflight override.
    const prompter = new ScriptedPrompter({
      text: [home, "voidvault"], // vault path, obsidian display name
      confirm: [true],
    })
    const logs: string[] = []
    const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "))
    })
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await initCommand({
        args: [],
        prefix,
        prompter,
        preflight: {
          ...fakePreflight,
          obsidian: { found: true, paths: ["/fake/path"] },
        },
        skipBuild: true,
      })
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
    const stdout = logs.join("\n")
    expect(stdout).toContain(`open Obsidian, "Open vault" → ${home}`)
    expect(stdout).toContain('enable "void-os"')
    expect(stdout).toContain("void-os ask tinker")
  })

  it("re-run without --force: no overwrites, marker not rewritten, report says already initialized", async () => {
    // First run: fresh seed
    await runInit([], { text: [home], confirm: [true] }).promise

    // Capture pre-rerun mtimes for starter files + marker.
    const before: Record<string, number> = {}
    for (const rel of [...STARTER_FILES, ".void/marker.json"]) {
      before[rel] = statSync(join(home, rel)).mtimeMs
    }

    // Sleep enough to guarantee a distinct mtime if anything were rewritten.
    // 50ms is plenty on macOS/APFS (mtime resolution is ns) and Linux (1ms).
    await new Promise((r) => setTimeout(r, 50))

    // Second run, no --force.
    const rerun = runInit([], { text: [home], confirm: [true] })
    await rerun.promise

    // mtime-stable: nothing overwritten.
    for (const rel of [...STARTER_FILES, ".void/marker.json"]) {
      const after = statSync(join(home, rel)).mtimeMs
      expect(after).toBe(before[rel])
    }

    // Report indicates already-initialized.
    const stdout = rerun.logs.join("\n")
    expect(stdout).toContain("already seeded")
    expect(stdout).not.toContain("git initialized + first commit")
  })

  it("re-run with --force: starter files re-copied (mtime bumped) but git history preserved", async () => {
    // First run: fresh seed
    await runInit([], { text: [home], confirm: [true] }).promise

    // Capture pre-rerun mtimes + initial commit SHA.
    const beforeMtimes: Record<string, number> = {}
    for (const rel of STARTER_FILES) {
      beforeMtimes[rel] = statSync(join(home, rel)).mtimeMs
    }
    const headBefore = Bun.spawnSync({
      cmd: ["git", "-C", home, "rev-parse", "HEAD"],
      stdout: "pipe",
    })
    expect(headBefore.exitCode).toBe(0)
    const shaBefore = new TextDecoder().decode(headBefore.stdout).trim()
    expect(shaBefore.length).toBeGreaterThan(0)

    // Sleep to ensure mtime differences are observable.
    await new Promise((r) => setTimeout(r, 50))

    // Second run, with --force.
    await runInit(["--force"], { text: [home], confirm: [true] }).promise

    // Starter files re-copied: mtime advanced.
    for (const rel of STARTER_FILES) {
      const after = statSync(join(home, rel)).mtimeMs
      expect(after).toBeGreaterThan(beforeMtimes[rel])
      // And content still matches source (byte-identical re-copy).
      const a = readFileSync(join(home, rel))
      const b = readFileSync(join(STARTER_SRC, rel))
      expect(a.equals(b)).toBe(true)
    }

    // Git history preserved: same initial commit SHA at HEAD.
    const headAfter = Bun.spawnSync({
      cmd: ["git", "-C", home, "rev-parse", "HEAD"],
      stdout: "pipe",
    })
    expect(headAfter.exitCode).toBe(0)
    const shaAfter = new TextDecoder().decode(headAfter.stdout).trim()
    expect(shaAfter).toBe(shaBefore)
  })
})

describe("initCommand() --non-interactive", () => {
  it("runs end-to-end with flag-only config, never prompts", async () => {
    const prompter = new ScriptedPrompter({ text: [], confirm: [] })
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await initCommand({
        args: ["--non-interactive", "--vault", home, "--skip-gh", "--skip-obsidian"],
        prefix,
        prompter,
        preflight: fakePreflight,
        skipBuild: true,
      })
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }

    expect(existsSync(home)).toBe(true)
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, ".void/marker.json"))).toBe(true)
    // No `intro:`/`outro:` log entries since prompter never invoked:
    expect(prompter.log.length).toBe(0)
  })

  it("missing --vault under --non-interactive exits 64", async () => {
    const prompter = new ScriptedPrompter({ text: [], confirm: [] })
    const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error(`exit:${c}`)
    }) as never)
    const errSpy = spyOn(console, "error").mockImplementation(() => {})

    try {
      await initCommand({
        args: ["--non-interactive"],
        prefix,
        prompter,
        preflight: fakePreflight,
        skipBuild: true,
      })
      throw new Error("should have exited")
    } catch (e) {
      expect((e as Error).message).toBe("exit:64")
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
