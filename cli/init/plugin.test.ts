import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPlugin, ensurePluginBuilt, pluginBuildEnv, PLUGIN_DIST_FILES } from "./plugin"

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
  writeFileSync(join(prefix, "plugin/dist/styles.css"), "/* css */")
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

  it("invokes bun run build in plugin dir when dist missing, with VOID_OS_PLUGIN_OUT pinned", () => {
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    let spawnedCmd = ""
    let spawnedArgs: string[] = []
    let spawnedCwd = ""
    let spawnedEnv: Record<string, string> = {}
    const r = ensurePluginBuilt({
      prefix,
      dryRun: false,
      spawn: (cmd, args, o) => {
        spawnedCmd = cmd
        spawnedArgs = args
        spawnedCwd = o.cwd
        spawnedEnv = o.env
        // Simulate successful build by creating dist with all required files.
        mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
        for (const f of PLUGIN_DIST_FILES) writeFileSync(join(prefix, "plugin/dist", f), "built")
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    expect(spawnedCmd).toBe("bun")
    expect(spawnedArgs).toEqual(["run", "build"])
    expect(spawnedCwd).toBe(join(prefix, "plugin"))
    // F3-regression: pre-build MUST pin out to <prefix>/plugin/dist; the
    // plugin's build.ts defaults to ~/void/.obsidian/plugins/void-os.
    expect(spawnedEnv.VOID_OS_PLUGIN_OUT).toBe(join(prefix, "plugin/dist"))
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

  it("treats exit==0 with missing artifacts as failure (F3 regression)", () => {
    // Simulates the prior bug: build wrote to ~/void/... instead of plugin/dist,
    // so spawn returns success but dist is still empty.
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    const r = ensurePluginBuilt({
      prefix,
      dryRun: false,
      spawn: () => ({ status: 0, stdout: "Done in 34ms", stderr: "" }),
    })
    expect(r.built).toBe(false)
    expect(r.ran).toBe(true)
    expect(r.error).toContain("missing")
  })

  it("ignores stderr noise when build succeeds (F3 false-positive)", () => {
    // Smoke test reported `plugin pre-build failed:` even though `Done in 34ms`
    // showed success. We must NOT treat non-empty stderr as failure when
    // exit==0 and all files are present.
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    const r = ensurePluginBuilt({
      prefix,
      dryRun: false,
      spawn: () => {
        mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
        for (const f of PLUGIN_DIST_FILES) writeFileSync(join(prefix, "plugin/dist", f), "x")
        return { status: 0, stdout: "Done in 34ms", stderr: "warn: deprecated foo" }
      },
    })
    expect(r).toEqual({ built: true, ran: true })
    expect(r.error).toBeUndefined()
  })

  it("re-builds when dist exists but key files are missing", () => {
    // Half-built dist (e.g. only main.js, missing styles.css) is treated as
    // not-built and triggers a rebuild rather than a silent no-op.
    rmSync(join(prefix, "plugin/dist/styles.css"))
    let spawned = false
    const r = ensurePluginBuilt({
      prefix,
      dryRun: false,
      spawn: () => {
        spawned = true
        writeFileSync(join(prefix, "plugin/dist/styles.css"), "/* css */")
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    expect(spawned).toBe(true)
    expect(r).toEqual({ built: true, ran: true })
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

  it("pluginBuildEnv() pins VOID_OS_PLUGIN_OUT to <prefix>/plugin/dist", () => {
    const e = pluginBuildEnv(prefix)
    expect(e.cmd).toBe("bun")
    expect(e.args).toEqual(["run", "build"])
    expect(e.cwd).toBe(join(prefix, "plugin"))
    expect(e.distDir).toBe(join(prefix, "plugin/dist"))
    expect(e.env.VOID_OS_PLUGIN_OUT).toBe(join(prefix, "plugin/dist"))
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
