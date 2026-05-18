import { describe, it, expect } from "bun:test"
import { promptObsidian, printNextSteps } from "./obsidian"
import { ScriptedPrompter } from "./prompter"

describe("promptObsidian", () => {
  it("darwin + user says yes → spawns `open obsidian://open?path=...`", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const spawn = (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { status: 0 } as any }
    const p = new ScriptedPrompter({ text: [], confirm: [true] })
    await promptObsidian({ vault: "/tmp/my vault", platform: "darwin", prompter: p, spawn })
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe("open")
    expect(calls[0].args[0]).toContain("obsidian://open?path=")
    expect(calls[0].args[0]).toContain(encodeURIComponent("/tmp/my vault"))
  })

  it("darwin + user says no → no spawn", async () => {
    const calls: any[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [false] })
    await promptObsidian({ vault: "/tmp/v", platform: "darwin", prompter: p, spawn: (c, a) => { calls.push({ c, a }); return { status: 0 } as any } })
    expect(calls).toHaveLength(0)
  })

  it("linux → no prompt, prints URL to stdout", async () => {
    const calls: any[] = []
    const out: string[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [] }) // no queue — should never be called
    await promptObsidian({
      vault: "/tmp/v", platform: "linux", prompter: p,
      spawn: (c, a) => { calls.push({ c, a }); return { status: 0 } as any },
      log: (s) => out.push(s),
    })
    expect(calls).toHaveLength(0)
    expect(out.join("\n")).toContain("obsidian://open?path=")
  })

  it("non-interactive → no prompt regardless of platform", async () => {
    const calls: any[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [] })
    await promptObsidian({ vault: "/tmp/v", platform: "darwin", interactive: false, prompter: p, spawn: (c, a) => { calls.push({ c, a }); return { status: 0 } as any } })
    expect(calls).toHaveLength(0)
  })

  it("open exits non-zero → warns but doesn't throw", async () => {
    const warnings: string[] = []
    const p = new ScriptedPrompter({ text: [], confirm: [true] })
    await promptObsidian({
      vault: "/tmp/v", platform: "darwin", prompter: p,
      spawn: () => ({ status: 1 } as any),
      warn: (s) => warnings.push(s),
    })
    expect(warnings.join("\n")).toMatch(/obsidian/i)
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
