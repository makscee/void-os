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
  mkdirSync(join(prefix, "vault-starter/agents/maya"), { recursive: true })
  mkdirSync(join(prefix, "vault-starter/skills"), { recursive: true })
  mkdirSync(join(prefix, "vault-starter/.void"), { recursive: true })
  mkdirSync(join(prefix, "vault-starter/.claude"), { recursive: true })
  mkdirSync(join(prefix, "vault-starter/.obsidian/plugins/void-os"), { recursive: true })
  writeFileSync(join(prefix, "vault-starter/CLAUDE.md"), "# claude\n")
  writeFileSync(join(prefix, "vault-starter/README.md"), "# vault\n")
  writeFileSync(join(prefix, "vault-starter/agents/maya/agent.md"), "---\nname: maya\n---\n")
  writeFileSync(join(prefix, "vault-starter/skills/.gitkeep"), "")
  writeFileSync(join(prefix, "vault-starter/.void/.gitkeep"), "")
  writeFileSync(join(prefix, "vault-starter/.claude/.gitkeep"), "")
  writeFileSync(join(prefix, "vault-starter/.obsidian/plugins/void-os/.gitkeep"), "")
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("provision()", () => {
  it("populates an empty target with vault-starter contents", async () => {
    await provision({ home, prefix, dryRun: false, force: false })
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, "agents/maya/agent.md"))).toBe(true)
    expect(existsSync(join(home, ".void/.gitkeep"))).toBe(true)
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
})
