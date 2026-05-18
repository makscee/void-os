import { describe, test, it, expect } from "bun:test"
import { pickFreeCtid, provisionLxc, lxcExec, defaultSshRunner } from "./lxc"

const pctListOutput = `VMID       Status     Lock         Name
100        running                 mcow-svc
198        running                 gh-runner-vos
9100       stopped                 vos-e2e-aaa
9102       stopped                 vos-e2e-bbb
`

describe("pickFreeCtid (max-in-range + 1)", () => {
  test("returns max-used-in-range + 1", () => {
    const ctid = pickFreeCtid(pctListOutput, [9100, 9199])
    expect(ctid).toBe(9103) // max in range is 9102, so next is 9103
  })

  test("returns range start when range fully unused", () => {
    expect(pickFreeCtid("VMID Status\n", [9100, 9199])).toBe(9100)
  })

  test("ignores CTIDs outside range when computing max", () => {
    expect(pickFreeCtid("VMID\n100 stopped\n198 running\n", [9100, 9199])).toBe(9100)
  })

  test("throws when max+1 would exceed range", () => {
    expect(() => pickFreeCtid("VMID\n9199 stopped\n", [9100, 9199])).toThrow(/no free CTID/)
  })
})

describe("pickFreeCtid", () => {
  const empty = "VMID       Status     Lock         Name\n"
  const oneInRange = "VMID       Status     Lock         Name\n9105       running                 vos-e2e-x\n"
  const outOfRange = "VMID       Status     Lock         Name\n8000       running                 other\n"
  const rangeFull = "VMID       Status     Lock         Name\n9199       running                 vos-e2e-last\n"

  it("returns range start when list empty", () => {
    expect(pickFreeCtid(empty, [9100, 9199])).toBe(9100)
  })
  it("returns max+1 within range", () => {
    expect(pickFreeCtid(oneInRange, [9100, 9199])).toBe(9106)
  })
  it("ignores ctids outside range", () => {
    expect(pickFreeCtid(outOfRange, [9100, 9199])).toBe(9100)
  })
  it("throws when range is full at top edge", () => {
    expect(() => pickFreeCtid(rangeFull, [9100, 9199])).toThrow(/no free CTID/)
  })
})

describe("provisionLxc", () => {
  it("picks ctid via pickFreeCtid and creates with explicit ctid", async () => {
    const calls: Array<{ host: string; cmd: string }> = []
    const fakeList = "VMID       Status     Lock         Name\n9100       running                 vos-e2e-a\n"
    const ssh: any = async (host: string, cmd: string) => {
      calls.push({ host, cmd })
      if (cmd.includes("pct list")) {
        return { stdout: fakeList, stderr: "", exitCode: 0 }
      }
      // create step
      return { stdout: "CTID=9101\n", stderr: "", exitCode: 0 }
    }
    const h = await provisionLxc({ ctidRange: [9100, 9199], towerHost: "tower", ssh })
    expect(h.ctid).toBe(9101)
    expect(calls.length).toBe(2)
    expect(calls[0].cmd).toMatch(/pct list/)
    expect(calls[1].cmd).toMatch(/pct create 9101 /)
    expect(calls[1].cmd).not.toMatch(/awk/)
  })

  it("retries on ctid collision (re-lists and re-picks)", async () => {
    let listCalls = 0
    let createCalls = 0
    const ssh: any = async (_host: string, cmd: string) => {
      if (cmd.includes("pct list")) {
        listCalls++
        // First list: ctid 9100 used → pick 9101. Second list (after collision): 9101 also used → pick 9102.
        return listCalls === 1
          ? { stdout: "VMID Status\n9100 running x\n", stderr: "", exitCode: 0 }
          : { stdout: "VMID Status\n9100 running x\n9101 running y\n", stderr: "", exitCode: 0 }
      }
      createCalls++
      if (createCalls === 1) {
        return { stdout: "", stderr: "CT 9101 already exists", exitCode: 1 }
      }
      return { stdout: "CTID=9102\n", stderr: "", exitCode: 0 }
    }
    const h = await provisionLxc({ ctidRange: [9100, 9199], towerHost: "tower", ssh })
    expect(h.ctid).toBe(9102)
    expect(listCalls).toBe(2)
    expect(createCalls).toBe(2)
  })

  it("throws after exhausting retries", async () => {
    const ssh: any = async (_host: string, cmd: string) => {
      if (cmd.includes("pct list")) {
        return { stdout: "VMID Status\n", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "CT 9100 already exists", exitCode: 1 }
    }
    await expect(
      provisionLxc({ ctidRange: [9100, 9199], towerHost: "tower", ssh }),
    ).rejects.toThrow(/exhausted .* attempts/)
  })

  it("throws immediately on non-collision error", async () => {
    const ssh: any = async (_host: string, cmd: string) => {
      if (cmd.includes("pct list")) {
        return { stdout: "VMID Status\n", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "permission denied", exitCode: 1 }
    }
    await expect(
      provisionLxc({ ctidRange: [9100, 9199], towerHost: "tower", ssh }),
    ).rejects.toThrow(/permission denied/)
  })
})

describe("lxcExec input option", () => {
  it("forwards input string to the ssh runner", async () => {
    let captured: { cmd: string; opts: any } | null = null
    const ssh: any = async (_host: string, cmd: string, opts: any) => {
      captured = { cmd, opts }
      return { stdout: "", stderr: "", exitCode: 0 }
    }
    await lxcExec(
      { ctid: 9101, hostname: "vos-e2e-x", towerHost: "tower" },
      "claudev login",
      { ssh, input: "secret-code\n" },
    )
    expect(captured!.opts.input).toBe("secret-code\n")
    // The wrapped cmd still base64s the inner cmd, so 'claudev login' should appear base64'd.
    const b64 = Buffer.from("claudev login").toString("base64")
    expect(captured!.cmd).toContain(b64)
    // Wrap MUST use process substitution `bash <(...)` — a `| bash` pipe would
    // consume the inner cmd's stdin and accessCode would never reach claudev login.
    expect(captured!.cmd).toContain("bash <(echo")
    expect(captured!.cmd).not.toMatch(/\| bash"?$/)
  })
})

describe("defaultSshRunner input forwarding", () => {
  it("forwards opts.input to the spawned process stdin", async () => {
    // Use injectable spawn pointing at `cat` directly — avoids requiring
    // a working localhost ssh in CI. defaultSshRunner accepts a 4th arg
    // (spawnImpl) for testability; production paths pass undefined.
    const { spawn } = await import("node:child_process")
    const spawnImpl: any = (_program: string, _args: string[]) => spawn("cat", [])
    const r = await defaultSshRunner("localhost", "cat", { input: "hello\n" }, spawnImpl)
    expect(r.stdout).toContain("hello")
    expect(r.exitCode).toBe(0)
  }, 10_000)
})
