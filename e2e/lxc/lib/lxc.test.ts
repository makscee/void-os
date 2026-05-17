import { describe, test, expect } from "bun:test"
import { pickFreeCtid } from "./lxc"

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
