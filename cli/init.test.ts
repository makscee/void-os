import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  lstatSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { provision, parseFlags, validateFlags, FlagsError, initCommand } from "./init"
import { ScriptedPrompter, PrompterCancelled } from "./init/prompter"
import type { PreflightReport } from "./init/preflight"

let tmpRoot: string
let prefix: string
let home: string

// Helper: writes a .void/marker.json the same shape seed() writes.
function writeMarker(dir: string) {
  mkdirSync(join(dir, ".void"), { recursive: true })
  writeFileSync(
    join(dir, ".void/marker.json"),
    JSON.stringify({ version: 1, createdAt: new Date().toISOString() }),
  )
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vos76-"))
  prefix = join(tmpRoot, "prefix")
  home = join(tmpRoot, "home")
  // Build a minimal fake prefix mirroring the brewed layout.
  mkdirSync(join(prefix, "starter-vault/agents/tinker"), { recursive: true })
  mkdirSync(join(prefix, "starter-vault/skills"), { recursive: true })
  // VOS-119 Task 6.1: .void is now a file marker written by seed(), not a starter-vault dir
  mkdirSync(join(prefix, "starter-vault/.claude"), { recursive: true })
  mkdirSync(join(prefix, "starter-vault/.obsidian/plugins/void-os"), { recursive: true })
  writeFileSync(join(prefix, "starter-vault/CLAUDE.md"), "# claude\n")
  writeFileSync(join(prefix, "starter-vault/README.md"), "# vault\n")
  writeFileSync(join(prefix, "starter-vault/agents/tinker/agent.md"), "---\nname: tinker\n---\n")
  writeFileSync(join(prefix, "starter-vault/skills/.gitkeep"), "")
  writeFileSync(join(prefix, "starter-vault/.claude/.gitkeep"), "")
  writeFileSync(join(prefix, "starter-vault/.obsidian/plugins/void-os/.gitkeep"), "")
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("provision()", () => {
  it("populates an empty target with starter-vault contents + writes .void/marker.json", async () => {
    await provision({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, "agents/tinker/agent.md"))).toBe(true)
    // VOS-123: .void is now a DIRECTORY containing marker.json (daemon needs
    // .void/ as a directory for state.sqlite, tmp/, traces/).
    expect(existsSync(join(home, ".void"))).toBe(true)
    expect(statSync(join(home, ".void")).isDirectory()).toBe(true)
    expect(statSync(join(home, ".void/marker.json")).isFile()).toBe(true)
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("# claude\n")
  })

  it("refuses to clobber a non-empty non-void target", async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "random.txt"), "user data\n")
    await expect(
      provision({ home, prefix, dryRun: false, force: false, gh: { push: false } }),
    ).rejects.toThrow(/refusing to clobber/)
  })

  it("treats target with .void marker as upgrade — does not require --force", async () => {
    mkdirSync(home, { recursive: true })
    writeMarker(home)
    writeFileSync(join(home, "CLAUDE.md"), "user override\n")
    await provision({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("user override\n")
    // upgrade is a no-op for templates unless --force
    expect(existsSync(join(home, ".void/marker.json"))).toBe(true)
    expect(statSync(join(home, ".void/marker.json")).isFile()).toBe(true)
  })

  it("upgrade preserves nested user edits to agents/skills", async () => {
    mkdirSync(home, { recursive: true })
    writeMarker(home)
    mkdirSync(join(home, "agents/tinker"), { recursive: true })
    writeFileSync(join(home, "agents/tinker/agent.md"), "user-customized tinker\n")
    mkdirSync(join(home, "skills/my-skill"), { recursive: true })
    writeFileSync(join(home, "skills/my-skill/SKILL.md"), "user skill\n")
    await provision({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    expect(readFileSync(join(home, "agents/tinker/agent.md"), "utf8")).toBe("user-customized tinker\n")
    expect(readFileSync(join(home, "skills/my-skill/SKILL.md"), "utf8")).toBe("user skill\n")
  })

  it("--force overwrites existing files", async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "CLAUDE.md"), "stale\n")
    await provision({ home, prefix, dryRun: false, force: true, gh: { push: false } })
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("# claude\n")
  })

  it("--dry-run writes nothing but reports what would be copied", async () => {
    const result = await provision({ home, prefix, dryRun: true, force: false, gh: { push: false } })
    expect(existsSync(home)).toBe(false)
    expect(result.copied.length).toBeGreaterThan(0)
  })

  it("creates target/.claude/skills symlink → ../skills", async () => {
    await provision({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    const link = join(home, ".claude/skills")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })
})

describe("parseFlags non-interactive", () => {
  it("--non-interactive sets nonInteractive=true", () => {
    const f = parseFlags(["--non-interactive", "--vault", "/tmp/v"])
    expect(f.nonInteractive).toBe(true)
    expect(f.vault).toBe("/tmp/v")
  })

  it("--gh-repo X parsed", () => {
    const f = parseFlags(["--non-interactive", "--vault", "/tmp/v", "--gh-repo", "myvault"])
    expect(f.ghRepo).toBe("myvault")
    expect(f.skipGh).toBe(false)
  })

  it("--skip-gh parsed", () => {
    const f = parseFlags(["--non-interactive", "--vault", "/tmp/v", "--skip-gh"])
    expect(f.skipGh).toBe(true)
  })

})

describe("validateFlags", () => {
  it("--non-interactive without --vault throws exit 64", () => {
    expect(() => validateFlags(parseFlags(["--non-interactive"])))
      .toThrow(FlagsError)
    try { validateFlags(parseFlags(["--non-interactive"])) }
    catch (e) {
      expect(e).toBeInstanceOf(FlagsError)
      expect((e as FlagsError).exitCode).toBe(64)
      expect((e as FlagsError).message).toMatch(/--non-interactive requires --vault/)
    }
  })

  it("--gh-repo + --skip-gh mutually exclusive (exit 64)", () => {
    try {
      validateFlags(parseFlags([
        "--non-interactive", "--vault", "/tmp/v",
        "--gh-repo", "x", "--skip-gh",
      ]))
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(FlagsError)
      expect((e as FlagsError).exitCode).toBe(64)
      expect((e as FlagsError).message).toMatch(/mutually exclusive/)
    }
  })

  it("valid --non-interactive --vault X passes", () => {
    expect(() => validateFlags(parseFlags([
      "--non-interactive", "--vault", "/tmp/v",
    ]))).not.toThrow()
  })

  it("interactive mode (no --non-interactive) passes without --vault", () => {
    expect(() => validateFlags(parseFlags([]))).not.toThrow()
  })
})

const passingPreflight: PreflightReport = {
  os: "linux",
  claude: { found: true },
  bun: { found: true },
  gh: { found: false, authed: false },
  obsidian: { found: false },
}

function fixturePrefix(root: string): string {
  const p = join(root, "prefix")
  mkdirSync(join(p, "starter-vault/agents/tinker"), { recursive: true })
  mkdirSync(join(p, "starter-vault/skills"), { recursive: true })
  mkdirSync(join(p, "starter-vault/.claude"), { recursive: true })
  mkdirSync(join(p, "starter-vault/.obsidian/plugins/void-os"), { recursive: true })
  writeFileSync(join(p, "starter-vault/CLAUDE.md"), "# claude\n")
  writeFileSync(join(p, "starter-vault/README.md"), "# vault\n")
  writeFileSync(join(p, "starter-vault/agents/tinker/agent.md"), "---\nname: tinker\n---\n")
  writeFileSync(join(p, "starter-vault/skills/.gitkeep"), "")
  writeFileSync(join(p, "starter-vault/.claude/.gitkeep"), "")
  writeFileSync(join(p, "starter-vault/.obsidian/plugins/void-os/.gitkeep"), "")
  return p
}

describe("initCommand new shape", () => {
  let root: string
  let pfx: string
  let vault: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vos143-t7-"))
    pfx = fixturePrefix(root)
    vault = join(root, "vault")
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("does NOT auto-start the daemon at end of init", async () => {
    const prompter = new ScriptedPrompter({
      text: [vault],
      confirm: [true],
      select: [vault],
    })
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await initCommand({
        args: ["--skip-build"],
        prefix: pfx,
        prompter,
        preflight: passingPreflight,
        promptObsidian: async () => {},
        printNextSteps: () => {},
      })
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
    // Seed ran (proves init completed) and no `daemon started ...` line was emitted.
    expect(existsSync(join(vault, "CLAUDE.md"))).toBe(true)
    const stdout = logSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n")
    expect(stdout).not.toContain("daemon started")
    expect(stdout).not.toContain("daemon already running")
  })

  it("calls promptObsidian after report with vault + interactive flag", async () => {
    const prompter = new ScriptedPrompter({
      text: [vault],
      confirm: [true],
      select: [vault],
    })
    const obsidianCalls: Array<{ vault: string; interactive: boolean }> = []
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    try {
      await initCommand({
        args: ["--skip-build"],
        prefix: pfx,
        prompter,
        preflight: passingPreflight,
        promptObsidian: async (o) => { obsidianCalls.push({ vault: o.vault, interactive: o.interactive }) },
        printNextSteps: () => {},
      })
    } finally {
      logSpy.mockRestore()
    }
    expect(obsidianCalls.length).toBe(1)
    expect(obsidianCalls[0]?.vault).toBe(vault)
    expect(obsidianCalls[0]?.interactive).toBe(true)
  })

  it("non-interactive mode: promptObsidian receives interactive=false", async () => {
    let captured: { interactive: boolean } | null = null
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    try {
      await initCommand({
        args: ["--non-interactive", "--vault", vault, "--skip-build"],
        prefix: pfx,
        preflight: passingPreflight,
        promptObsidian: async (o) => { captured = { interactive: o.interactive } },
        printNextSteps: () => {},
      })
    } finally {
      logSpy.mockRestore()
    }
    expect(captured).not.toBeNull()
    expect(captured!.interactive).toBe(false)
  })

  it("propagates PrompterCancelled from promptObsidian (does not continue to printNextSteps)", async () => {
    const prompter = new ScriptedPrompter({
      text: [vault],
      confirm: [true],
      select: [vault],
    })
    let nextStepsCalls = 0
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    let thrown: unknown = null
    try {
      await initCommand({
        args: ["--skip-build"],
        prefix: pfx,
        prompter,
        preflight: passingPreflight,
        promptObsidian: async () => { throw new PrompterCancelled() },
        printNextSteps: () => { nextStepsCalls++ },
      })
    } catch (e) {
      thrown = e
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
    expect(thrown).toBeInstanceOf(PrompterCancelled)
    expect(nextStepsCalls).toBe(0)
    // No swallowing into a warning either.
    const warns = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n")
    expect(warns).not.toContain("obsidian prompt raised")
  })

  it("calls printNextSteps before exit", async () => {
    let nextStepsCalls = 0
    let capturedVault = ""
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    try {
      await initCommand({
        args: ["--non-interactive", "--vault", vault, "--skip-build"],
        prefix: pfx,
        preflight: passingPreflight,
        promptObsidian: async () => {},
        printNextSteps: (o) => { nextStepsCalls++; capturedVault = o.vault },
      })
    } finally {
      logSpy.mockRestore()
    }
    expect(nextStepsCalls).toBe(1)
    expect(capturedVault).toBe(vault)
  })
})
