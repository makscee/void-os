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
  it("collects vault path and gh repo when all detected", async () => {
    const p = new ScriptedPrompter({
      text: ["vault"],
      confirm: [true, true], // push to gh, proceed
      select: ["/Users/x/vault"],
    })
    const d = await configure(baseReport, p, noRepoDeps)
    expect(d.vaultPath).toBe("/Users/x/vault")
    expect(d.gh).toEqual({ push: true, repoName: "vault" })
  })

  it("skips gh prompts when gh not authed", async () => {
    const p = new ScriptedPrompter({
      text: [],
      confirm: [true],
      select: ["/Users/x/vault"],
    })
    const r = { ...baseReport, gh: { found: true, authed: false } }
    const d = await configure(r, p, noRepoDeps)
    expect(d.gh).toEqual({ push: false })
  })

  it("returns cancelled=true when user declines outro confirm", async () => {
    const p = new ScriptedPrompter({
      text: ["vault"],
      confirm: [true, false], // push yes, proceed NO
      select: ["/Users/x/vault"],
    })
    const d = await configure(baseReport, p, noRepoDeps)
    expect(d.cancelled).toBe(true)
  })

  it("expands ~ in vault path (via custom)", async () => {
    const p = new ScriptedPrompter({
      text: ["~/vault", "vault"],
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
      skipGh: false,
    })
    expect(d.vaultPath).toBe(homedir() + "/foo")
    expect(d.gh.push).toBe(false)
    expect(d.cancelled).toBe(false)
  })

  it("--gh-repo X with gh available → push true", () => {
    const r = { ...niBaseReport, gh: { found: true, authed: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v", ghRepo: "myrepo",
      skipGh: false,
    })
    expect(d.gh).toEqual({ push: true, repoName: "myrepo" })
  })

  it("--gh-repo X with gh NOT available → throws FlagsError exit 65", () => {
    const r = { ...niBaseReport, gh: { found: false, authed: false } }
    expect(() => decideFromFlags(r, {
      nonInteractive: true, vault: "/v", ghRepo: "myrepo",
      skipGh: false,
    })).toThrow(/gh not available/)
  })

  it("skipGh wins over ghRepo when both reach decideFromFlags", () => {
    const r = { ...niBaseReport, gh: { found: true, authed: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true,
      vault: "/tmp/v",
      ghRepo: "x",
      skipGh: true,
    })
    expect(d.gh).toEqual({ push: false })
  })
})

describe("configure gh push gate", () => {
  it("interactive: gh push defaults to false (initialValue), not true", async () => {
    const reportWithGh = { ...baseReport, gh: { found: true, authed: true } }
    const p = new ScriptedPrompter({
      text: [],
      confirm: [false, true], // gh push: accept default (false); proceed: yes
      select: [join(homedir(), "vault")],
    })
    const d = await configure(reportWithGh, p, noRepoDeps)
    expect(d.gh.push).toBe(false)
    expect(p.confirmInitialValues).toContain(false) // gh prompt's initialValue was false
  })

  it("non-interactive: skipGh=false + no ghRepo → no push (was: implicit push)", () => {
    const reportWithGh = { ...niBaseReport, gh: { found: true, authed: true } }
    const d = decideFromFlags(reportWithGh, {
      nonInteractive: true,
      vault: "/tmp/v",
      skipGh: false,
    })
    expect(d.gh.push).toBe(false)
  })

  it("non-interactive: --gh-repo opts in", () => {
    const reportWithGh = { ...niBaseReport, gh: { found: true, authed: true } }
    const d = decideFromFlags(reportWithGh, {
      nonInteractive: true,
      vault: "/tmp/v",
      skipGh: false,
      ghRepo: "my-vault",
    })
    expect(d.gh).toEqual({ push: true, repoName: "my-vault" })
  })
})
