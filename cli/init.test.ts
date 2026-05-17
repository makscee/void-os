import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, lstatSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { provision } from "./init"

let tmpRoot: string
let prefix: string
let home: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vos76-"))
  prefix = join(tmpRoot, "prefix")
  home = join(tmpRoot, "home")
  // Build a minimal fake prefix mirroring the brewed layout.
  mkdirSync(join(prefix, "starter-vault/agents/maya"), { recursive: true })
  mkdirSync(join(prefix, "starter-vault/skills"), { recursive: true })
  // VOS-119 Task 6.1: .void is now a file marker written by seed(), not a starter-vault dir
  mkdirSync(join(prefix, "starter-vault/.claude"), { recursive: true })
  mkdirSync(join(prefix, "starter-vault/.obsidian/plugins/void-os"), { recursive: true })
  writeFileSync(join(prefix, "starter-vault/CLAUDE.md"), "# claude\n")
  writeFileSync(join(prefix, "starter-vault/README.md"), "# vault\n")
  writeFileSync(join(prefix, "starter-vault/agents/maya/agent.md"), "---\nname: maya\n---\n")
  writeFileSync(join(prefix, "starter-vault/skills/.gitkeep"), "")
  writeFileSync(join(prefix, "starter-vault/.claude/.gitkeep"), "")
  writeFileSync(join(prefix, "starter-vault/.obsidian/plugins/void-os/.gitkeep"), "")
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("provision()", () => {
  it("populates an empty target with starter-vault contents", async () => {
    await provision({ home, prefix, dryRun: false, force: false })
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, "agents/maya/agent.md"))).toBe(true)
    // VOS-119 Task 8.2 will restore as file-marker assertion
    // expect(existsSync(join(home, ".void/.gitkeep"))).toBe(true)
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("# claude\n")
  })

  it("refuses to clobber a non-empty non-void target", async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "random.txt"), "user data\n")
    await expect(
      provision({ home, prefix, dryRun: false, force: false }),
    ).rejects.toThrow(/refusing to clobber/)
  })

  it("treats target with .void marker as upgrade — does not require --force", async () => {
    mkdirSync(join(home, ".void"), { recursive: true })
    writeFileSync(join(home, ".void/.gitkeep"), "")
    writeFileSync(join(home, "CLAUDE.md"), "user override\n")
    await provision({ home, prefix, dryRun: false, force: false })
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("user override\n")
    expect(existsSync(join(home, "agents/maya/agent.md"))).toBe(true)
  })

  it("upgrade preserves nested user edits to agents/skills", async () => {
    mkdirSync(join(home, ".void"), { recursive: true })
    writeFileSync(join(home, ".void/.gitkeep"), "")
    mkdirSync(join(home, "agents/maya"), { recursive: true })
    writeFileSync(join(home, "agents/maya/agent.md"), "user-customized maya\n")
    mkdirSync(join(home, "skills/my-skill"), { recursive: true })
    writeFileSync(join(home, "skills/my-skill/SKILL.md"), "user skill\n")
    await provision({ home, prefix, dryRun: false, force: false })
    expect(readFileSync(join(home, "agents/maya/agent.md"), "utf8")).toBe("user-customized maya\n")
    expect(readFileSync(join(home, "skills/my-skill/SKILL.md"), "utf8")).toBe("user skill\n")
    // New files from starter that didn't exist before are still copied.
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
  })

  it("--force overwrites existing files", async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "CLAUDE.md"), "stale\n")
    await provision({ home, prefix, dryRun: false, force: true })
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("# claude\n")
  })

  it("warns when plugin/dist is missing but does not throw", async () => {
    const result = await provision({ home, prefix, dryRun: false, force: false })
    expect(result.warnings.some((w) => w.includes("plugin build artifact missing"))).toBe(true)
    expect(existsSync(join(home, ".obsidian/plugins/void-os"))).toBe(true) // dir from starter
  })

  it("copies plugin/dist contents into .obsidian/plugins/void-os when present", async () => {
    mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
    writeFileSync(join(prefix, "plugin/dist/main.js"), "console.log('plugin')\n")
    writeFileSync(join(prefix, "plugin/dist/manifest.json"), "{}\n")
    await provision({ home, prefix, dryRun: false, force: false })
    expect(existsSync(join(home, ".obsidian/plugins/void-os/main.js"))).toBe(true)
    expect(existsSync(join(home, ".obsidian/plugins/void-os/manifest.json"))).toBe(true)
  })

  it("--dry-run writes nothing but reports what would be copied", async () => {
    const result = await provision({ home, prefix, dryRun: true, force: false })
    expect(existsSync(home)).toBe(false)
    expect(result.copied.length).toBeGreaterThan(0)
  })

  it("creates target/.claude/skills symlink → ../skills", async () => {
    await provision({ home, prefix, dryRun: false, force: false })
    const link = join(home, ".claude/skills")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })
})
