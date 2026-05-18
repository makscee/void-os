import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { needsPluginBuild, runBuild, BuildError } from "./build"

let prefix: string

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), "vos119-build-"))
  mkdirSync(join(prefix, "plugin/src"), { recursive: true })
  mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
  writeFileSync(join(prefix, "plugin/package.json"), "{}")
  writeFileSync(join(prefix, "plugin/bun.lock"), "")
  writeFileSync(join(prefix, "plugin/src/main.ts"), "x")
})

afterEach(() => rmSync(prefix, { recursive: true, force: true }))

function setMtime(path: string, secsFromNow: number) {
  const t = (Date.now() + secsFromNow * 1000) / 1000
  utimesSync(path, t, t)
}

describe("needsPluginBuild()", () => {
  it("returns true when dist/main.js missing", () => {
    expect(needsPluginBuild(prefix)).toBe(true)
  })

  it("returns false when dist newer than src + package.json + lockfile", () => {
    setMtime(join(prefix, "plugin/src/main.ts"), -100)
    setMtime(join(prefix, "plugin/package.json"), -100)
    setMtime(join(prefix, "plugin/bun.lock"), -100)
    writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
    setMtime(join(prefix, "plugin/dist/main.js"), 0)
    expect(needsPluginBuild(prefix)).toBe(false)
  })

  it("returns true when package.json newer than dist (dep bump)", () => {
    writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
    setMtime(join(prefix, "plugin/dist/main.js"), -100)
    setMtime(join(prefix, "plugin/src/main.ts"), -200)
    setMtime(join(prefix, "plugin/bun.lock"), -200)
    setMtime(join(prefix, "plugin/package.json"), 0)
    expect(needsPluginBuild(prefix)).toBe(true)
  })

  it("returns true when src newer than dist", () => {
    writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
    setMtime(join(prefix, "plugin/dist/main.js"), -100)
    setMtime(join(prefix, "plugin/src/main.ts"), 0)
    expect(needsPluginBuild(prefix)).toBe(true)
  })
})

describe("runBuild()", () => {
  it("plugin-build spawn pins VOID_OS_PLUGIN_OUT to <prefix>/plugin/dist (F3 regression)", () => {
    // Force needsPluginBuild() to return true: leave dist with no main.js.
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    mkdirSync(join(prefix, "plugin/dist"), { recursive: true })

    type SpawnCall = { cmd: string; args: string[]; cwd: string; env: Record<string, string> }
    const calls: SpawnCall[] = []
    const fakeSpawn: any = (cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env ?? {} })
      return { status: 0, stdout: "", stderr: "" }
    }
    runBuild({ prefix, skipBuild: false, spawnSync: fakeSpawn })

    // We expect three spawns: bun install (root), bun install (plugin), bun run build (plugin).
    expect(calls.length).toBe(3)
    const build = calls[2]
    expect(build.cmd).toBe("bun")
    expect(build.args).toEqual(["run", "build"])
    expect(build.cwd).toBe(join(prefix, "plugin"))
    expect(build.env.VOID_OS_PLUGIN_OUT).toBe(join(prefix, "plugin/dist"))
  })

  it("skipBuild=true skips all spawns", () => {
    let called = false
    const fakeSpawn: any = () => { called = true; return { status: 0 } }
    runBuild({ prefix, skipBuild: true, spawnSync: fakeSpawn })
    expect(called).toBe(false)
  })

  it("throws BuildError when plugin build fails", () => {
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
    let n = 0
    const fakeSpawn: any = () => {
      n++
      // First two installs succeed, build fails.
      return { status: n >= 3 ? 1 : 0 }
    }
    expect(() => runBuild({ prefix, skipBuild: false, spawnSync: fakeSpawn }))
      .toThrow(BuildError)
  })
})
