import { describe, it, expect } from "bun:test"
import { ScriptedPrompter } from "./prompter"

describe("ScriptedPrompter", () => {
  it("returns queued text answers in order", async () => {
    const p = new ScriptedPrompter({
      text: ["/tmp/vault", "myrepo"],
      confirm: [],
    })
    expect(await p.text({ message: "vault?" })).toBe("/tmp/vault")
    expect(await p.text({ message: "repo?" })).toBe("myrepo")
  })

  it("returns queued confirm answers in order", async () => {
    const p = new ScriptedPrompter({ text: [], confirm: [true, false] })
    expect(await p.confirm({ message: "push?" })).toBe(true)
    expect(await p.confirm({ message: "again?" })).toBe(false)
  })

  it("throws on under-queue", async () => {
    const p = new ScriptedPrompter({ text: [], confirm: [] })
    await expect(p.text({ message: "x" })).rejects.toThrow(/no scripted text/i)
  })

  it("cancel() throws PrompterCancelled", async () => {
    const p = new ScriptedPrompter({ text: [], confirm: [] })
    expect(() => p.cancel()).toThrow(/cancelled/i)
  })
})
