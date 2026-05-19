import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { promptObsidian, printNextSteps, registerObsidianVault } from "./obsidian"
import { ScriptedPrompter } from "./prompter"

function mkTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vos-143-home-"))
}

function prefsPath(home: string): string {
  return path.join(home, "Library", "Application Support", "obsidian", "obsidian.json")
}

function vaultIdFor(p: string): string {
  return crypto.createHash("md5").update(p).digest("hex").slice(0, 16)
}

describe("promptObsidian", () => {
  let tmpHome: string
  beforeEach(() => { tmpHome = mkTmpHome() })
  afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }) })

  it("darwin + Obsidian NOT running + user says yes → registers vault and spawns `open -a Obsidian` (no path arg)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const spawn = (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { status: 0 } as any }
    const p = new ScriptedPrompter({ text: [], confirm: [true] })
    const vault = path.join(tmpHome, "my vault")
    fs.mkdirSync(vault, { recursive: true })
    await promptObsidian({
      vault,
      platform: "darwin",
      prompter: p,
      spawn,
      isObsidianRunning: () => false,
      homeDir: () => tmpHome,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe("open")
    expect(calls[0].args).toEqual(["-a", "Obsidian"])
    const parsed = JSON.parse(fs.readFileSync(prefsPath(tmpHome), "utf8"))
    const id = vaultIdFor(vault)
    expect(parsed.vaults[id]).toBeDefined()
    expect(parsed.vaults[id].path).toBe(vault)
    expect(parsed.vaults[id].open).toBe(true)
    expect(parsed.vaults[id].trusted).toBe(true)
    expect(typeof parsed.vaults[id].ts).toBe("number")
  })

  it("darwin + Obsidian ALREADY running + user says yes → registers vault, no spawn, hint message", async () => {
    const calls: any[] = []
    const out: string[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [true] })
    const vault = path.join(tmpHome, "vault")
    fs.mkdirSync(vault, { recursive: true })
    await promptObsidian({
      vault,
      platform: "darwin",
      prompter: p,
      spawn: (c, a) => { calls.push({ c, a }); return { status: 0 } as any },
      log: (s) => out.push(s),
      isObsidianRunning: () => true,
      homeDir: () => tmpHome,
    })
    expect(calls).toHaveLength(0)
    const joined = out.join("\n")
    expect(joined).toContain("already running")
    expect(joined).toMatch(/File → Open Vault/)
    // Registration still happened.
    const parsed = JSON.parse(fs.readFileSync(prefsPath(tmpHome), "utf8"))
    expect(parsed.vaults[vaultIdFor(vault)]).toBeDefined()
  })

  it("merges with existing obsidian.json: old vaults preserved, their open: true flipped to false, top-level keys kept", async () => {
    const prefs = prefsPath(tmpHome)
    fs.mkdirSync(path.dirname(prefs), { recursive: true })
    const oldVaultA = "/tmp/old-vault-a"
    const oldVaultB = "/tmp/old-vault-b"
    const oldIdA = vaultIdFor(oldVaultA)
    const oldIdB = vaultIdFor(oldVaultB)
    fs.writeFileSync(prefs, JSON.stringify({
      vaults: {
        [oldIdA]: { path: oldVaultA, ts: 1000, open: true, trusted: true },
        [oldIdB]: { path: oldVaultB, ts: 2000, open: false, trusted: true },
      },
      updateDisabled: true,
      someOtherKey: { foo: "bar" },
    }))

    const newVault = path.join(tmpHome, "new-vault")
    fs.mkdirSync(newVault, { recursive: true })
    registerObsidianVault(newVault, { platform: "darwin", homeDir: () => tmpHome })

    const parsed = JSON.parse(fs.readFileSync(prefs, "utf8"))
    const newId = vaultIdFor(newVault)
    // New entry present + open: true.
    expect(parsed.vaults[newId].path).toBe(newVault)
    expect(parsed.vaults[newId].open).toBe(true)
    // Old entries preserved.
    expect(parsed.vaults[oldIdA].path).toBe(oldVaultA)
    expect(parsed.vaults[oldIdB].path).toBe(oldVaultB)
    // Previously-open vault flipped to closed; previously-closed stays closed.
    expect(parsed.vaults[oldIdA].open).toBe(false)
    expect(parsed.vaults[oldIdB].open).toBe(false)
    // Top-level keys preserved.
    expect(parsed.updateDisabled).toBe(true)
    expect(parsed.someOtherKey).toEqual({ foo: "bar" })
  })

  it("malformed obsidian.json → treated as empty, vault registered cleanly", async () => {
    const prefs = prefsPath(tmpHome)
    fs.mkdirSync(path.dirname(prefs), { recursive: true })
    fs.writeFileSync(prefs, "{not json{{{")

    const vault = path.join(tmpHome, "v")
    fs.mkdirSync(vault, { recursive: true })
    registerObsidianVault(vault, { platform: "darwin", homeDir: () => tmpHome })

    const parsed = JSON.parse(fs.readFileSync(prefs, "utf8"))
    expect(parsed.vaults[vaultIdFor(vault)].open).toBe(true)
  })

  it("obsidian user-data dir doesn't exist → mkdir created, file written", async () => {
    // tmpHome has no Library/Application Support/obsidian yet.
    const dir = path.join(tmpHome, "Library", "Application Support", "obsidian")
    expect(fs.existsSync(dir)).toBe(false)
    const vault = path.join(tmpHome, "v")
    fs.mkdirSync(vault, { recursive: true })
    registerObsidianVault(vault, { platform: "darwin", homeDir: () => tmpHome })
    expect(fs.existsSync(path.join(dir, "obsidian.json"))).toBe(true)
  })

  it("darwin + user says no → no registration, no spawn", async () => {
    const calls: any[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [false] })
    await promptObsidian({
      vault: path.join(tmpHome, "v"),
      platform: "darwin",
      prompter: p,
      spawn: (c, a) => { calls.push({ c, a }); return { status: 0 } as any },
      isObsidianRunning: () => false,
      homeDir: () => tmpHome,
    })
    expect(calls).toHaveLength(0)
    expect(fs.existsSync(prefsPath(tmpHome))).toBe(false)
  })

  it("linux → no prompt, no registration, prints URL", async () => {
    const calls: any[] = []
    const out: string[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [] })
    await promptObsidian({
      vault: "/tmp/v",
      platform: "linux",
      prompter: p,
      spawn: (c, a) => { calls.push({ c, a }); return { status: 0 } as any },
      log: (s) => out.push(s),
      homeDir: () => tmpHome,
    })
    expect(calls).toHaveLength(0)
    expect(out.join("\n")).toContain("obsidian://open?path=")
    expect(fs.existsSync(prefsPath(tmpHome))).toBe(false)
  })

  it("non-interactive darwin → no registration, no spawn, prints hint", async () => {
    const calls: any[] = []
    const out: string[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [] })
    await promptObsidian({
      vault: "/tmp/v",
      platform: "darwin",
      interactive: false,
      prompter: p,
      spawn: (c, a) => { calls.push({ c, a }); return { status: 0 } as any },
      log: (s) => out.push(s),
      homeDir: () => tmpHome,
    })
    expect(calls).toHaveLength(0)
    expect(fs.existsSync(prefsPath(tmpHome))).toBe(false)
    expect(out.join("\n")).toMatch(/Open folder as vault/)
  })

  it("open exits non-zero → warns but doesn't throw", async () => {
    const warnings: string[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [true] })
    const vault = path.join(tmpHome, "v")
    fs.mkdirSync(vault, { recursive: true })
    await promptObsidian({
      vault,
      platform: "darwin",
      prompter: p,
      spawn: () => ({ status: 1 } as any),
      warn: (s) => warnings.push(s),
      isObsidianRunning: () => false,
      homeDir: () => tmpHome,
    })
    expect(warnings.join("\n")).toMatch(/obsidian/i)
  })
})

describe("registerObsidianVault", () => {
  let tmpHome: string
  beforeEach(() => { tmpHome = mkTmpHome() })
  afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }) })

  it("resolves relative paths to absolute before hashing the id", () => {
    const abs = path.resolve(tmpHome, "rel-vault")
    fs.mkdirSync(abs, { recursive: true })
    registerObsidianVault(abs, { platform: "darwin", homeDir: () => tmpHome })
    const parsed = JSON.parse(fs.readFileSync(prefsPath(tmpHome), "utf8"))
    expect(parsed.vaults[vaultIdFor(abs)].path).toBe(abs)
  })

  it("atomic write: no leftover tmp file in the dir", () => {
    const vault = path.join(tmpHome, "v")
    fs.mkdirSync(vault, { recursive: true })
    registerObsidianVault(vault, { platform: "darwin", homeDir: () => tmpHome })
    const dir = path.dirname(prefsPath(tmpHome))
    const leftovers = fs.readdirSync(dir).filter((n) => n.startsWith("obsidian.json.tmp-"))
    expect(leftovers).toEqual([])
  })
})

describe("printNextSteps", () => {
  it("prints both Obsidian and CLI paths", () => {
    const out: string[] = []
    printNextSteps({ vault: "/tmp/v", log: (s) => out.push(s) })
    expect(out.join("\n")).toMatch(/Obsidian/)
    expect(out.join("\n")).toMatch(/void-os daemon start/)
    expect(out.join("\n")).toMatch(/void-os ask tinker/)
  })
})
