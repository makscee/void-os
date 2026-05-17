import { describe, it, expect, beforeEach, afterEach } from "bun:test"
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
import { provision, parseFlags } from "./init"

let tmpRoot: string
let prefix: string
let home: string

// Helper: writes a .void marker file the same shape seed() writes.
function writeMarker(dir: string) {
  writeFileSync(
    join(dir, ".void"),
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
  it("populates an empty target with starter-vault contents + writes .void file marker", async () => {
    await provision({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, "agents/tinker/agent.md"))).toBe(true)
    // VOS-119 Task 8.2: .void is now a JSON FILE marker (was a directory in pre-T6 fixture).
    expect(existsSync(join(home, ".void"))).toBe(true)
    expect(statSync(join(home, ".void")).isFile()).toBe(true)
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
    expect(existsSync(join(home, ".void"))).toBe(true)
    expect(statSync(join(home, ".void")).isFile()).toBe(true)
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

  it("--skip-obsidian and --obsidian-vault parsed", () => {
    const f = parseFlags([
      "--non-interactive", "--vault", "/tmp/v",
      "--obsidian-vault", "myvault",
    ])
    expect(f.obsidianVault).toBe("myvault")
    expect(f.skipObsidian).toBe(false)

    const g = parseFlags(["--non-interactive", "--vault", "/tmp/v", "--skip-obsidian"])
    expect(g.skipObsidian).toBe(true)
  })
})
