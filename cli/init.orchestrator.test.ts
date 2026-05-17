import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initCommand } from "./init"
import { ScriptedPrompter } from "./init/prompter"
import type { PreflightReport } from "./init/preflight"

// Composed orchestrator test: exercises preflight (stubbed) → configure (Scripted)
// → build (skipped) → seed (real, against a fake prefix) → plugin (real) → report.
// Foundation for T11's full E2E.

let tmpRoot: string
let prefix: string
let home: string

const fakePreflight: PreflightReport = {
  os: "linux",
  claude: { found: true },
  bun: { found: true },
  gh: { found: false, authed: false }, // disables gh prompts in configure
  obsidian: { found: false },          // disables obsidian prompt in configure
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vos119-t8-"))
  prefix = join(tmpRoot, "prefix")
  home = join(tmpRoot, "home")

  // Minimal starter-vault fixture (same shape as init.test.ts).
  mkdirSync(join(prefix, "starter-vault/agents/tinker"), { recursive: true })
  mkdirSync(join(prefix, "starter-vault/skills"), { recursive: true })
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

describe("initCommand() — phase orchestrator", () => {
  it("runs preflight → configure (Scripted) → seed → plugin → report on a fresh target", async () => {
    const prompter = new ScriptedPrompter({
      // configure asks: vault path (text), then proceed (confirm).
      // No gh/obsidian prompts because fakePreflight has both false.
      text: [home],
      confirm: [true],
    })

    const logs: string[] = []
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    })

    try {
      await initCommand({
        args: ["--skip-build"],
        prefix,
        prompter,
        preflight: fakePreflight,
      })
    } finally {
      logSpy.mockRestore()
    }

    // Seed effects landed:
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("# claude\n")
    expect(existsSync(join(home, "agents/tinker/agent.md"))).toBe(true)
    // .void is a directory, marker.json lives inside it
    expect(statSync(join(home, ".void")).isDirectory()).toBe(true)
    expect(statSync(join(home, ".void/marker.json")).isFile()).toBe(true)
    const marker = JSON.parse(readFileSync(join(home, ".void/marker.json"), "utf8"))
    expect(marker.version).toBe(1)

    // Report was printed
    const stdout = logs.join("\n")
    expect(stdout).toContain(`void-os seeded at ${home}`)
    expect(stdout).toContain("git initialized + first commit")

    // ScriptedPrompter consumed both prompts
    expect(prompter.log.some((l) => l.startsWith("intro"))).toBe(true)
    expect(prompter.log.some((l) => l.startsWith("outro"))).toBe(true)
  })

  it("--home flag overrides the vault path chosen via configure", async () => {
    const overrideHome = join(tmpRoot, "elsewhere")
    const prompter = new ScriptedPrompter({
      text: [home],
      confirm: [true],
    })
    const logSpy = spyOn(console, "log").mockImplementation(() => {})

    try {
      await initCommand({
        args: ["--skip-build", "--home", overrideHome],
        prefix,
        prompter,
        preflight: fakePreflight,
      })
    } finally {
      logSpy.mockRestore()
    }

    // Seed wrote to overrideHome, NOT the prompter-supplied home
    expect(existsSync(join(overrideHome, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(false)
  })

  it("re-running on a seeded vault reports an upgrade (no fresh-seed line)", async () => {
    // First run: fresh seed
    {
      const prompter = new ScriptedPrompter({ text: [home], confirm: [true] })
      const logSpy = spyOn(console, "log").mockImplementation(() => {})
      try {
        await initCommand({
          args: ["--skip-build"],
          prefix,
          prompter,
          preflight: fakePreflight,
        })
      } finally {
        logSpy.mockRestore()
      }
    }

    // Second run: same dir → upgrade path
    const prompter2 = new ScriptedPrompter({ text: [home], confirm: [true] })
    const logs: string[] = []
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    })
    try {
      await initCommand({
        args: ["--skip-build"],
        prefix,
        prompter: prompter2,
        preflight: fakePreflight,
      })
    } finally {
      logSpy.mockRestore()
    }

    const stdout = logs.join("\n")
    expect(stdout).toContain("already seeded")
    expect(stdout).not.toContain("git initialized + first commit")
  })
})
