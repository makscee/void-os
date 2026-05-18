import { describe, it, expect, mock } from "bun:test"
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

  it("accepts placeholder option without throwing (forwarded to clack)", async () => {
    // ScriptedPrompter must accept the new placeholder field on text opts
    // so production callers can pass it through uniformly. Behavior:
    // answer queue still drives the return value.
    const p = new ScriptedPrompter({ text: ["~/vault"], confirm: [] })
    const r = await p.text({
      message: "vault?",
      defaultValue: "~/vault",
      placeholder: "~/vault",
    })
    expect(r).toBe("~/vault")
  })
})

describe("ClackPrompter", () => {
  it("forwards placeholder (falls back to defaultValue) to clack.text", async () => {
    const calls: Array<Record<string, unknown>> = []
    mock.module("@clack/prompts", () => ({
      intro: () => {},
      outro: () => {},
      cancel: () => {},
      isCancel: () => false,
      text: (opts: Record<string, unknown>) => {
        calls.push(opts)
        return Promise.resolve("answer")
      },
      confirm: () => Promise.resolve(true),
    }))

    // Re-import after mock.module install so ClackPrompter binds to the mock.
    const { ClackPrompter } = await import("./prompter?placeholder-test")
    const p = new ClackPrompter()

    await p.text({ message: "m1", defaultValue: "d1", placeholder: "p1" })
    expect(calls[0]?.placeholder).toBe("p1")
    expect(calls[0]?.defaultValue).toBe("d1")

    // No explicit placeholder → fall back to defaultValue so clack renders it.
    await p.text({ message: "m2", defaultValue: "d2" })
    expect(calls[1]?.placeholder).toBe("d2")
  })
})
