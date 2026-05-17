import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { resolve } from "node:path"
import { provisionLxc, lxcExec, waitForNet, type LxcHandle } from "./lib/lxc"
import { installBaseDeps, loginClaudev } from "./lib/setup"
import { rsyncIntoLxc } from "./lib/rsync"
import { dumpAndDestroy } from "./lib/diagnostics"

const REPO_ROOT = resolve(import.meta.dir, "../..")

// Gate the whole live suite on VOS_E2E_LIVE=1 so plain `bun test` does not
// try to provision a Proxmox LXC during unit/CI runs.
const LIVE = process.env.VOS_E2E_LIVE === "1"

let h: LxcHandle | null = null

if (LIVE) {
  beforeAll(async () => {
    const accessCode = process.env.CLAUDEV_ACCESS_CODE
    if (!accessCode) {
      throw new Error(
        "CLAUDEV_ACCESS_CODE env required (mint via tools/mint-claudev-code.sh or admin.makscee.ru)",
      )
    }

    h = await provisionLxc({})
    await waitForNet(h, 30_000)
    await installBaseDeps(h)
    await loginClaudev(h, accessCode)
    await rsyncIntoLxc(REPO_ROOT, h, "/root/void-os")
    await lxcExec(h, "cd /root/void-os && bun install && bun link", { timeoutMs: 120_000 })
  }, 300_000)

  afterAll(async () => {
    await dumpAndDestroy(h)
  })
}

describe.skipIf(!LIVE)("void-os init --non-interactive on fresh LXC", () => {
  it(
    "seeds vault, daemon healthy, ask tinker writes test.md",
    async () => {
      const initR = await lxcExec(
        h!,
        "void-os init --non-interactive --vault /root/vault --skip-gh --skip-obsidian",
        { timeoutMs: 60_000 },
      )
      expect(initR.exitCode).toBe(0)
      expect(initR.stdout).toMatch(/vault:|seed/)

      // T0b RESOLVED — `void-os init` does NOT auto-start the daemon.
      // Evidence (per spec): cli/init.ts phases preflight→configure→build→seed→plugin→report
      // contain zero `daemon` references. Therefore explicitly start the daemon.
      const dStart = await lxcExec(h!, "void-os daemon start --vault /root/vault")
      expect(dStart.exitCode).toBe(0)
      const dR = await lxcExec(h!, "void-os daemon status")
      expect(dR.exitCode).toBe(0)
      expect(dR.stdout).toMatch(/listening|running/i)

      const askR = await lxcExec(
        h!,
        `void-os ask tinker "create a file called test.md with content hello"`,
        { timeoutMs: 180_000 }, // Anthropic p99 tool-use round-trips can exceed 60s
      )
      expect(askR.exitCode).toBe(0)

      const cat = await lxcExec(h!, "cat /root/vault/test.md")
      expect(cat.exitCode).toBe(0)
      expect(cat.stdout).toContain("hello")
    },
    240_000,
  )
})
