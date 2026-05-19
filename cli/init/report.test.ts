import { describe, it, expect } from "bun:test"
import { formatReport, type SeedResultLike } from "./report"
import type { PreflightReport } from "./preflight"
import type { Decisions } from "./configure"
import type { PluginResult } from "./plugin"

const basePreflight: PreflightReport = {
  os: "darwin",
  claude: { found: true, version: "1.0.0" },
  bun: { found: true, version: "1.0.0" },
  gh: { found: true, authed: true },
  obsidian: { found: true },
}

const baseDecisions: Decisions = {
  vaultPath: "/Users/u/vault",
  gh: { push: true, repoName: "u/vault" },
  cancelled: false,
}

const freshSeed: SeedResultLike = {
  isFreshSeed: true,
  gh: { pushed: true, remote: "git@github.com:u/vault.git" },
}

const installedPlugin: PluginResult = {
  installed: true,
  target: "/Users/u/.obsidian/plugins/void-os",
  warnings: [],
}

describe("formatReport()", () => {
  it("fresh seed + gh pushed + plugin installed + obsidian found", () => {
    const report = formatReport({
      vaultPath: "/Users/u/vault",
      preflight: basePreflight,
      decisions: baseDecisions,
      seed: freshSeed,
      plugin: installedPlugin,
    })

    expect(report).toContain("void-os seeded at /Users/u/vault")
    expect(report).toContain("git initialized + first commit")
    expect(report).toContain("pushed to git@github.com:u/vault.git")
    expect(report).toContain("plugin copied to .obsidian/plugins/void-os/")
    expect(report).toContain("next:")
    expect(report).toContain("open Obsidian")
    expect(report).toContain("/Users/u/vault")
    expect(report).toContain('Settings → Community plugins → enable "void-os"')
    expect(report).toContain("chat with Tinker")
    expect(report).toContain("void-os ask <agent>")
    expect(report).toContain("void-os chat <agent>")
    expect(report).not.toContain("VOS-118")
  })

  it("re-run (not fresh) shows re-applied headline + force hint", () => {
    const report = formatReport({
      vaultPath: "/Users/u/vault",
      preflight: basePreflight,
      decisions: baseDecisions,
      seed: { isFreshSeed: false, gh: { pushed: false } },
      plugin: installedPlugin,
    })
    expect(report).toContain("already seeded at /Users/u/vault")
    expect(report).toContain("re-applied build + plugin only")
    expect(report).not.toContain("git initialized + first commit")
    expect(report).toContain("Pass --force to re-seed")
  })

  it("no gh push opted out -> remote: none hint", () => {
    const decisions: Decisions = {
      ...baseDecisions,
      gh: { push: false },
    }
    const report = formatReport({
      vaultPath: "/Users/u/vault",
      preflight: basePreflight,
      decisions,
      seed: { isFreshSeed: true, gh: { pushed: false } },
      plugin: installedPlugin,
    })
    expect(report).toContain("remote: none")
    expect(report).toContain("gh repo create")
  })

  it("gh push opted in but skipped with warning shows warning", () => {
    const report = formatReport({
      vaultPath: "/Users/u/vault",
      preflight: basePreflight,
      decisions: baseDecisions,
      seed: { isFreshSeed: true, gh: { pushed: false, warning: "gh not authed" } },
      plugin: installedPlugin,
    })
    expect(report).toContain("gh push skipped: gh not authed")
  })

  it("plugin not installed shows missing-artifact line", () => {
    const report = formatReport({
      vaultPath: "/Users/u/vault",
      preflight: basePreflight,
      decisions: baseDecisions,
      seed: freshSeed,
      plugin: { installed: false, target: "", warnings: ["missing"] },
    })
    expect(report).toContain("plugin: not installed (build artifact missing)")
  })

  it("obsidian missing -> install obsidian hint instead of open hint", () => {
    const preflight: PreflightReport = {
      ...basePreflight,
      obsidian: { found: false },
    }
    const report = formatReport({
      vaultPath: "/Users/u/vault",
      preflight,
      decisions: baseDecisions,
      seed: freshSeed,
      plugin: installedPlugin,
    })
    expect(report).toContain("install Obsidian: https://obsidian.md")
    expect(report).toContain("open vault at /Users/u/vault")
    expect(report).not.toContain('Settings → Community plugins → enable "void-os"')
  })
})
