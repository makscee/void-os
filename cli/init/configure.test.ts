import { describe, it, expect } from "bun:test"
import { configure } from "./configure"
import { ScriptedPrompter } from "./prompter"
import type { PreflightReport } from "./preflight"

const baseReport: PreflightReport = {
  os: "darwin",
  claude: { found: true },
  bun: { found: true },
  gh: { found: true, authed: true },
  obsidian: { found: true },
}

describe("configure()", () => {
  it("collects vault path, gh repo, and obsidian name when all detected", async () => {
    const p = new ScriptedPrompter({
      text: ["/Users/x/vault", "vault", "void"],
      confirm: [true, true], // push to gh, proceed
    })
    const d = await configure(baseReport, p)
    expect(d.vaultPath).toBe("/Users/x/vault")
    expect(d.gh).toEqual({ push: true, repoName: "vault" })
    expect(d.obsidianVaultName).toBe("void")
  })

  it("skips gh prompts when gh not authed", async () => {
    const p = new ScriptedPrompter({
      text: ["/Users/x/vault", "void"],
      confirm: [true],
    })
    const r = { ...baseReport, gh: { found: true, authed: false } }
    const d = await configure(r, p)
    expect(d.gh).toEqual({ push: false })
  })

  it("skips obsidian prompt when not found", async () => {
    const p = new ScriptedPrompter({
      text: ["/Users/x/vault", "vault"],
      confirm: [true, true],
    })
    const r = { ...baseReport, obsidian: { found: false } }
    const d = await configure(r, p)
    expect(d.obsidianVaultName).toBeUndefined()
  })

  it("returns cancelled=true when user declines outro confirm", async () => {
    const p = new ScriptedPrompter({
      text: ["/Users/x/vault", "vault", "void"],
      confirm: [true, false], // push yes, proceed NO
    })
    const d = await configure(baseReport, p)
    expect(d.cancelled).toBe(true)
  })

  it("expands ~ in vault path", async () => {
    const p = new ScriptedPrompter({
      text: ["~/vault", "vault", "void"],
      confirm: [true, true],
    })
    const d = await configure(baseReport, p)
    expect(d.vaultPath.startsWith("/")).toBe(true)
    expect(d.vaultPath.endsWith("/vault")).toBe(true)
  })
})
