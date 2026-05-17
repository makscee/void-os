import type { LxcHandle } from "./lxc"
import { lxcExec, destroyLxc } from "./lxc"

const DUMPS: Array<[string, string]> = [
  ["daemon log", "cat /root/.void-os/daemon.log 2>/dev/null | tail -200"],
  ["vault tree", "find /root/vault -type f 2>/dev/null | head -50"],
  ["journalctl", "journalctl -xe --no-pager 2>/dev/null | tail -100"],
  ["void-os ps", "ps aux 2>/dev/null | grep -E 'void-os|bun' | grep -v grep"],
]

export async function dumpAndDestroy(h: LxcHandle | null): Promise<void> {
  if (!h) return
  for (const [label, cmd] of DUMPS) {
    try {
      const r = await lxcExec(h, cmd, { allowFailure: true, timeoutMs: 15_000 })
      process.stderr.write(`\n--- ${label} (CTID ${h.ctid}) ---\n${r.stdout}\n`)
    } catch (e) {
      process.stderr.write(`\n--- ${label} dump failed: ${(e as Error).message} ---\n`)
    }
  }
  try {
    await destroyLxc(h)
  } catch (e) {
    process.stderr.write(`destroyLxc failed (CTID ${h.ctid}): ${(e as Error).message}\n`)
  }
}
