import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPlugin, ensurePluginBuilt } from "./plugin"

let root: string
let prefix: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vos119-plugin-"))
  prefix = join(root, "prefix")
  home = join(root, "home")
  mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
  writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
  writeFileSync(join(prefix, "plugin/dist/manifest.json"), "{}")
  mkdirSync(home, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("installPlugin()", () => {
  it("copies plugin/dist to <home>/.obsidian/plugins/void-os", () => {
    const r = installPlugin({ prefix, home, dryRun: false })
    expect(existsSync(join(home, ".obsidian/plugins/void-os/main.js"))).toBe(true)
    expect(existsSync(join(home, ".obsidian/plugins/void-os/manifest.json"))).toBe(true)
    expect(readFileSync(join(home, ".obsidian/plugins/void-os/main.js"), "utf8")).toBe("built")
    expect(r.installed).toBe(true)
    expect(r.target).toBe(join(home, ".obsidian/plugins/void-os"))
    expect(r.warnings).toEqual([])
  })

  it("does not write files when dryRun is true", () => {
    const r = installPlugin({ prefix, home, dryRun: true })
    expect(existsSync(join(home, ".obsidian/plugins/void-os/main.js"))).toBe(false)
    expect(r.installed).toBe(true)
  })

  it("warns + returns installed=false when dist missing", () => {
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    const r = installPlugin({ prefix, home, dryRun: false })
    expect(r.installed).toBe(false)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings[0]).toContain("plugin build artifact missing")
  })
})

describe("ensurePluginBuilt()", () => {
  it("no-op when plugin/dist already exists", () => {
    let called = false
    const r = ensurePluginBuilt({
      prefix,
      dryRun: false,
      spawn: () => { called = true; return { status: 0 } },
    })
    expect(r).toEqual({ built: true, ran: false })
    expect(called).toBe(false)
  })

  it("invokes bun run build in plugin dir when dist missing", () => {
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    let spawnedCmd = ""
    let spawnedArgs: string[] = []
    let spawnedCwd = ""
    const r = ensurePluginBuilt({
      prefix,
      dryRun: false,
      spawn: (cmd, args, o) => {
        spawnedCmd = cmd
        spawnedArgs = args
        spawnedCwd = o.cwd
        // Simulate successful build by creating dist.
        mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
        writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    expect(spawnedCmd).toBe("bun")
    expect(spawnedArgs).toEqual(["run", "build"])
    expect(spawnedCwd).toBe(join(prefix, "plugin"))
    expect(r).toEqual({ built: true, ran: true })
  })

  it("returns error when bun run build fails", () => {
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    const r = ensurePluginBuilt({
      prefix,
      dryRun: false,
      spawn: () => ({ status: 1, stdout: "", stderr: "build broke" }),
    })
    expect(r.built).toBe(false)
    expect(r.ran).toBe(true)
    expect(r.error).toContain("build broke")
  })

  it("dryRun skips spawn entirely", () => {
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    let called = false
    const r = ensurePluginBuilt({
      prefix,
      dryRun: true,
      spawn: () => { called = true; return { status: 0 } },
    })
    expect(called).toBe(false)
    expect(r.ran).toBe(false)
  })

  it("no-op when plugin dir itself is missing", () => {
    rmSync(join(prefix, "plugin"), { recursive: true })
    let called = false
    const r = ensurePluginBuilt({
      prefix,
      dryRun: false,
      spawn: () => { called = true; return { status: 0 } },
    })
    expect(called).toBe(false)
    expect(r.ran).toBe(false)
  })
})
