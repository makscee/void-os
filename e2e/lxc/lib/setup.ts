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
  // Pattern mirrors void-fleet src/lifecycles/provision.ts installClaudev:
  //   apt deps → Bun → NodeSource 20.x → claudev installer → npm prefix in $HOME/.local
  //   → npm install -g @anthropic-ai/claude-code → probe both binaries.
  // claudev does NOT bundle the Anthropic claude CLI — they are installed
  // independently; claudev wraps `claude` at runtime.
  const _pin = getClaudevPin() // surfaces parse errors early; install.sh always pulls latest server-side
  void _pin

  await lxcExec(
    h,
    `set -e
     export DEBIAN_FRONTEND=noninteractive
     # LXCs on tower have flaky IPv6 egress (vmbr0 DHCP rarely gets a stable v6).
     # Force apt to v4 globally so fetches don't stall on AAAA lookup timeouts.
     printf 'Acquire::ForceIPv4 "true";\\n' > /etc/apt/apt.conf.d/99-force-ipv4
     # Retry up to 3 times — the home-LAN egress occasionally drops a fetch.
     for i in 1 2 3; do
       apt-get update -qq && apt-get install -y --fix-missing -qq curl git unzip ca-certificates && break
       echo "apt attempt $i failed, retrying after 5s..." >&2
       sleep 5
     done
     # Final check — fail loudly if curl/git missing.
     command -v curl >/dev/null && command -v git >/dev/null`,
    { timeoutMs: 300_000 },
  )

  // Bun (for void-os runtime):
  await lxcExec(
    h,
    `set -e
     curl -fsSL https://bun.sh/install | bash
     ln -sf /root/.bun/bin/bun /usr/local/bin/bun`,
    { timeoutMs: 90_000 },
  )

  // NodeSource 20.x (needed for @anthropic-ai/claude-code via npm):
  await lxcExec(
    h,
    `set -e
     command -v npm && node --version | grep -E '^v(20|2[1-9])\\.' && exit 0
     curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
     export DEBIAN_FRONTEND=noninteractive
     apt-get install -y nodejs`,
    { timeoutMs: 180_000 },
  )

  // claudev (POSIX-sh installer — drops binary in ~/.local/bin):
  await lxcExec(
    h,
    `set -e
     curl -fsSL https://auth.makscee.ru/claudev/install.sh | sh`,
    { timeoutMs: 90_000 },
  )

  // Persist npm prefix so global installs land in ~/.local (no EACCES):
  await lxcExec(h, `npm config set prefix "$HOME/.local"`, { timeoutMs: 15_000 })

  // Anthropic claude CLI:
  await lxcExec(
    h,
    `set -e
     export PATH="$HOME/.local/bin:$PATH"
     npm install --global @anthropic-ai/claude-code`,
    { timeoutMs: 180_000 },
  )

  // Verify both binaries reachable via the rc-managed PATH. Skip `claudev --version`
  // here — claudev triggers the access-code prompt at first invocation when no
  // token exists. loginClaudev() exercises the version path implicitly via login.
  const v = await lxcExec(
    h,
    `bash -lc 'command -v claudev && command -v claude'`,
    { allowFailure: true },
  )
  if (v.exitCode !== 0) {
    throw new Error(
      `installBaseDeps verification failed (exit ${v.exitCode}): ${v.stderr || v.stdout}`,
    )
  }
}

export async function loginClaudev(h: LxcHandle, accessCode: string): Promise<void> {
  // claudev v1 exchanges access code → opaque void-auth session id, stored at
  // /root/.claudev/token. The runtime claudev wrapper later trades that session
  // for a pool API key from void-keys when invoking `claude`. So we verify the
  // token file exists with sane size; we do NOT check for an "sk-ant-" prefix
  // (that would only show up in v2's bundled flow).
  await lxcExec(h, "claudev login", {
    timeoutMs: 30_000,
    input: accessCode + "\n",
  })
  const ver = await lxcExec(
    h,
    `bash -lc 'test -s /root/.claudev/token && wc -c < /root/.claudev/token'`,
    { allowFailure: true },
  )
  const size = parseInt(ver.stdout.trim() || "0", 10)
  if (ver.exitCode !== 0 || size < 16) {
    throw new Error(
      `loginClaudev verification failed: token absent or too small (exit ${ver.exitCode}, size ${size})`,
    )
  }
}
