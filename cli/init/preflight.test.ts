import { describe, it, expect } from "bun:test"
import { detect } from "./preflight"

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
