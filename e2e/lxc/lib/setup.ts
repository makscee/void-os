import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { LxcHandle } from "./lxc"
import { lxcExec } from "./lxc"

const CLAUDEV_PIN_FILE = join(import.meta.dir, "..", ".claudev-version")

export function getClaudevPin(): string {
  const raw = readFileSync(CLAUDEV_PIN_FILE, "utf8").trim()
  if (!raw) throw new Error(`empty pin in ${CLAUDEV_PIN_FILE}`)
  if (!/^[a-f0-9]{7,40}$/i.test(raw) && !/^v?[\d.]+/.test(raw)) {
    throw new Error(`invalid claudev pin in ${CLAUDEV_PIN_FILE}: ${raw}`)
  }
  return raw
}

export async function installBaseDeps(h: LxcHandle): Promise<void> {
  const pin = getClaudevPin()

  await lxcExec(
    h,
    `set -e
     export DEBIAN_FRONTEND=noninteractive
     apt-get update
     apt-get install -y curl git unzip ca-certificates`,
    { timeoutMs: 120_000 },
  )

  // Bun:
  await lxcExec(
    h,
    `set -e
     curl -fsSL https://bun.sh/install | bash
     ln -sf /root/.bun/bin/bun /usr/local/bin/bun`,
    { timeoutMs: 90_000 },
  )

  // Claudev pinned:
  await lxcExec(
    h,
    `set -e
     rm -rf /root/claudev
     git clone https://github.com/makscee/claudev /root/claudev
     cd /root/claudev && git checkout ${pin}
     ./install.sh`,
    { timeoutMs: 90_000 },
  )

  // Verify claude is on PATH (claudev shim):
  const v = await lxcExec(h, "which claude && claude --version 2>&1 | head -1", {
    allowFailure: true,
  })
  if (v.exitCode !== 0) {
    throw new Error(`claudev install verification failed: ${v.stderr || v.stdout}`)
  }
}

export async function loginClaudev(h: LxcHandle, accessCode: string): Promise<void> {
  // Heredoc-pipe the code into claudev login. Token lands at /root/.claudev/token.
  await lxcExec(h, `printf '%s\\n' "${accessCode}" | claudev login`, { timeoutMs: 15_000 })
  const ver = await lxcExec(
    h,
    `test -f /root/.claudev/token && head -c 7 /root/.claudev/token`,
    { allowFailure: true },
  )
  if (ver.exitCode !== 0 || !ver.stdout.startsWith("sk-ant-")) {
    throw new Error(
      `loginClaudev verification failed: token absent or wrong prefix (got "${ver.stdout}")`,
    )
  }
}
