import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { needsPluginBuild } from "./build"

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
