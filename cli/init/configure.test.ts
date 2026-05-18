import { describe, it, expect } from "bun:test"
import { homedir } from "node:os"
import { cwd } from "node:process"
import { join } from "node:path"
import { configure, decideFromFlags } from "./configure"
import { ScriptedPrompter } from "./prompter"
import type { PreflightReport } from "./preflight"

const baseReport: PreflightReport = {
  os: "darwin",
  claude: { found: true },
  bun: { found: true },
  gh: { found: true, authed: true },
  obsidian: { found: true },
}

const noRepoDeps = { isInsideVoidOsRepo: () => false }

describe("configure()", () => {
  it("collects vault path, gh repo, and obsidian name when all detected", async () => {
    const p = new ScriptedPrompter({
      text: ["vault", "void"],
      confirm: [true, true], // push to gh, proceed
      select: ["/Users/x/vault"],
    })
    const d = await configure(baseReport, p, noRepoDeps)
    expect(d.vaultPath).toBe("/Users/x/vault")
    expect(d.gh).toEqual({ push: true, repoName: "vault" })
    expect(d.obsidianVaultName).toBe("void")
  })

  it("skips gh prompts when gh not authed", async () => {
    const p = new ScriptedPrompter({
      text: ["void"],
      confirm: [true],
      select: ["/Users/x/vault"],
    })
    const r = { ...baseReport, gh: { found: true, authed: false } }
    const d = await configure(r, p, noRepoDeps)
    expect(d.gh).toEqual({ push: false })
  })

  it("skips obsidian prompt when not found", async () => {
    const p = new ScriptedPrompter({
      text: ["vault"],
      confirm: [true, true],
      select: ["/Users/x/vault"],
    })
    const r = { ...baseReport, obsidian: { found: false } }
    const d = await configure(r, p, noRepoDeps)
    expect(d.obsidianVaultName).toBeUndefined()
  })

  it("returns cancelled=true when user declines outro confirm", async () => {
    const p = new ScriptedPrompter({
      text: ["vault", "void"],
      confirm: [true, false], // push yes, proceed NO
      select: ["/Users/x/vault"],
    })
    const d = await configure(baseReport, p, noRepoDeps)
    expect(d.cancelled).toBe(true)
  })

  it("expands ~ in vault path (via custom)", async () => {
    const p = new ScriptedPrompter({
      text: ["~/vault", "vault", "void"],
      confirm: [true, true],
      select: ["__custom__"],
    })
    const d = await configure(baseReport, p, noRepoDeps)
    expect(d.vaultPath.startsWith("/")).toBe(true)
    expect(d.vaultPath.endsWith("/vault")).toBe(true)
  })
})

const pickerReport: PreflightReport = {
  os: "darwin",
  claude: { found: true },
  bun: { found: true },
  gh: { found: false, authed: false },
  obsidian: { found: false },
}

describe("configure picker", () => {
  it("offers $PWD / ~/void-os-vault / ~/vault / custom", async () => {
    const p = new ScriptedPrompter({
      text: [],
      confirm: [true],
      select: [cwd()],
    })
    const d = await configure(pickerReport, p, noRepoDeps)
    expect(d.vaultPath).toBe(cwd())
    expect(p.lastSelectOptions?.map((o) => o.value)).toEqual([
      cwd(),
      join(homedir(), "void-os-vault"),
      join(homedir(), "vault"),
      "__custom__",
    ])
  })

  it("custom path branch prompts for text", async () => {
    const p = new ScriptedPrompter({
      text: ["/abs/path"],
      confirm: [true],
      select: ["__custom__"],
    })
    const d = await configure(pickerReport, p, noRepoDeps)
    expect(d.vaultPath).toBe("/abs/path")
  })

  it("repo-clone hint shown on $PWD option when inside void-os repo", async () => {
    const p = new ScriptedPrompter({
      text: [],
      confirm: [true],
      select: [join(homedir(), "void-os-vault")],
    })
    const d = await configure(pickerReport, p, { isInsideVoidOsRepo: () => true })
    const pwdOpt = p.lastSelectOptions?.find((o) => o.value === cwd())
    expect(pwdOpt).toBeDefined()
    expect(pwdOpt?.label).toMatch(/inside void-os clone/)
    expect(d.vaultPath).toBe(join(homedir(), "void-os-vault"))
  })

  it("throws when operator picks $PWD inside the clone", async () => {
    const p = new ScriptedPrompter({
      text: [],
      confirm: [],
      select: [cwd()],
    })
    await expect(
      configure(pickerReport, p, { isInsideVoidOsRepo: () => true }),
    ).rejects.toThrow(/Refusing to seed inside the void-os clone/)
  })

  it("non-interactive: --vault inside repo throws exit 2", () => {
    expect(() =>
      decideFromFlags(
        pickerReport,
        {
          nonInteractive: true,
          vault: "/path/to/void-os-repo",
          skipGh: true,
          skipObsidian: true,
        },
        { isInsideVoidOsRepo: (p) => p === "/path/to/void-os-repo" },
      ),
    ).toThrow(/Refusing to seed inside the void-os clone/)
  })
})

const niBaseReport: PreflightReport = {
  os: "linux",
  claude: { found: true },
  bun: { found: true },
  gh: { found: false, authed: false },
  obsidian: { found: false },
}

describe("decideFromFlags", () => {
  it("vault path expansion (~/foo → home)", () => {
    const d = decideFromFlags(niBaseReport, {
      nonInteractive: true, vault: "~/foo",
      skipGh: false, skipObsidian: false,
    })
    expect(d.vaultPath).toBe(homedir() + "/foo")
    expect(d.gh.push).toBe(false)
    expect(d.cancelled).toBe(false)
  })

  it("--gh-repo X with gh available → push true", () => {
    const r = { ...niBaseReport, gh: { found: true, authed: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v", ghRepo: "myrepo",
      skipGh: false, skipObsidian: false,
    })
    expect(d.gh).toEqual({ push: true, repoName: "myrepo" })
  })

  it("--gh-repo X with gh NOT available → throws FlagsError exit 65", () => {
    const r = { ...niBaseReport, gh: { found: false, authed: false } }
    expect(() => decideFromFlags(r, {
      nonInteractive: true, vault: "/v", ghRepo: "myrepo",
      skipGh: false, skipObsidian: false,
    })).toThrow(/gh not available/)
  })

  it("--skip-obsidian → undefined obsidianVaultName even if obsidian detected", () => {
    const r = { ...niBaseReport, obsidian: { found: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v", skipObsidian: true,
      skipGh: false,
    })
    expect(d.obsidianVaultName).toBeUndefined()
  })

  it("obsidian detected + no skip + no override → default \"void\"", () => {
    const r = { ...niBaseReport, obsidian: { found: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v",
      skipGh: false, skipObsidian: false,
    })
    expect(d.obsidianVaultName).toBe("void")
  })

  it("--obsidian-vault X overrides default", () => {
    const r = { ...niBaseReport, obsidian: { found: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v", obsidianVault: "custom",
      skipGh: false, skipObsidian: false,
    })
    expect(d.obsidianVaultName).toBe("custom")
  })

  it("skipGh wins over ghRepo when both reach decideFromFlags", () => {
    const r = { ...niBaseReport, gh: { found: true, authed: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true,
      vault: "/tmp/v",
      ghRepo: "x",
      skipGh: true,
      skipObsidian: true,
    })
    expect(d.gh).toEqual({ push: false })
  })
})
