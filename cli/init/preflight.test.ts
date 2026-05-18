import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detect, detectClaudev, enforce, PreflightError } from "./preflight"

describe("preflight detect()", () => {
  it("returns a report shape with os, claude, bun, gh, obsidian fields", () => {
    const r = detect({
      whichSync: (cmd: string) => (cmd === "bun" ? "/usr/local/bin/bun" : null),
      fileExists: () => false,
      runSync: () => ({ status: 1, stdout: "", stderr: "" }),
      platform: "darwin",
    })
    expect(r.os).toBe("darwin")
    expect(r.bun.found).toBe(true)
    expect(r.claude.found).toBe(false)
    expect(r.gh.found).toBe(false)
    expect(r.gh.authed).toBe(false)
    expect(r.obsidian.found).toBe(false)
  })

  it("marks gh authed only when gh AND auth status returns 0", () => {
    const r = detect({
      whichSync: (cmd: string) => (cmd === "gh" ? "/usr/local/bin/gh" : null),
      fileExists: () => false,
      runSync: (cmd, args) => {
        if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return { status: 0, stdout: "", stderr: "" }
        return { status: 1, stdout: "", stderr: "" }
      },
      platform: "darwin",
    })
    expect(r.gh.found).toBe(true)
    expect(r.gh.authed).toBe(true)
  })

  it("detects Obsidian on macOS via /Applications/Obsidian.app", () => {
    const r = detect({
      whichSync: () => null,
      fileExists: (p: string) => p === "/Applications/Obsidian.app",
      runSync: () => ({ status: 1, stdout: "", stderr: "" }),
      platform: "darwin",
    })
    expect(r.obsidian.found).toBe(true)
  })

  it("os is 'unknown' for unsupported platforms", () => {
    const r = detect({
      whichSync: () => null,
      fileExists: () => false,
      runSync: () => ({ status: 1, stdout: "", stderr: "" }),
      platform: "win32",
    })
    expect(r.os).toBe("unknown")
  })
})

describe("preflight claudev", () => {
  let tmpRoot: string
  let envBinPath: string
  let pathDir: string

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "preflight-claudev-"))
    envBinPath = join(tmpRoot, "fake-claudev-env")
    writeFileSync(envBinPath, "#!/bin/sh\necho fake\n")
    chmodSync(envBinPath, 0o755)
    pathDir = join(tmpRoot, "pathdir")
    mkdirSync(pathDir, { recursive: true })
    const onPath = join(pathDir, "claudev")
    writeFileSync(onPath, "#!/bin/sh\necho fake\n")
    chmodSync(onPath, 0o755)
  })

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("reports claudev found when VOID_OS_CC_BIN points at an executable", () => {
    const report = detect({ env: { VOID_OS_CC_BIN: envBinPath, PATH: "" } })
    expect(report.claudev.found).toBe(true)
    expect(report.claudev.path).toBe(envBinPath)
  })

  it("reports claudev found when on PATH", () => {
    const report = detect({ env: { PATH: pathDir } })
    expect(report.claudev.found).toBe(true)
  })

  it("reports claudev missing when neither env nor PATH resolves", () => {
    const report = detect({ env: { PATH: "/nonexistent-dir-for-preflight-test" } })
    expect(report.claudev.found).toBe(false)
  })

  it("enforce throws PreflightError exit 2 when claudev missing", () => {
    const report = { bun: { found: true, path: "/bin/bun" }, claude: { found: true }, claudev: { found: false } } as any
    expect(() => enforce(report, { offerBrewInstallBun: () => false }))
      .toThrow(PreflightError)
  })

  it("error message includes VOID_OS_CC_BIN hint", () => {
    const report = { bun: { found: true, path: "/bin/bun" }, claude: { found: true }, claudev: { found: false } } as any
    try { enforce(report, { offerBrewInstallBun: () => false }) }
    catch (e) {
      expect((e as PreflightError).message).toMatch(/VOID_OS_CC_BIN/)
      expect((e as PreflightError).exitCode).toBe(2)
    }
  })

  it("detectClaudev directly returns env source when VOID_OS_CC_BIN set", () => {
    const r = detectClaudev({ VOID_OS_CC_BIN: envBinPath, PATH: "" })
    expect(r.found).toBe(true)
    expect(r.source).toBe("env")
    expect(r.path).toBe(envBinPath)
  })
})
