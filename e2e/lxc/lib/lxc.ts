import { spawn } from "node:child_process"

export interface LxcHandle {
  ctid: number
  hostname: string
  towerHost: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type SshRunner = (
  host: string,
  cmd: string,
  opts?: { timeoutMs?: number; input?: string },
) => Promise<ExecResult>

// --- pure parser, unit-tested ---

// Picks max(used ∩ range) + 1, or range start when range is empty.
// Matches the awk one-liner in the provisionLxc shell snippet — one contract.
export function pickFreeCtid(pctListOut: string, range: [number, number]): number {
  let maxInRange = -1
  for (const line of pctListOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const n = Number(m[1])
    if (n >= range[0] && n <= range[1] && n > maxInRange) maxInRange = n
  }
  const next = maxInRange === -1 ? range[0] : maxInRange + 1
  if (next > range[1]) throw new Error(`no free CTID in [${range[0]}, ${range[1]}]`)
  return next
}

// --- ssh runner ---

// `spawnImpl` is injectable for tests — production callers pass undefined and
// get the real `node:child_process` spawn. The 4th parameter is intentionally
// outside the SshRunner type so the public contract stays clean.
export const defaultSshRunner = (
  host: string,
  cmd: string,
  opts?: { timeoutMs?: number; input?: string },
  spawnImpl: typeof spawn = spawn,
): Promise<ExecResult> =>
  new Promise((resolve) => {
    const p = spawnImpl("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      host,
      cmd,
    ])
    if (opts?.input !== undefined) {
      p.stdin.write(opts.input)
      p.stdin.end()
    }
    let stdout = ""
    let stderr = ""
    p.stdout.on("data", (d) => {
      stdout += d.toString()
    })
    p.stderr.on("data", (d) => {
      stderr += d.toString()
    })
    let timed = false
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timed = true
          p.kill("SIGKILL")
        }, opts.timeoutMs)
      : null
    p.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        exitCode: timed ? 124 : code ?? -1,
      })
    })
  })

// --- LXC operations ---

const PCT = "sudo /usr/local/sbin/vos-pct" // sudoers-scoped wrapper
const LOCK = "/var/lock/vos-e2e-ctid"

export async function provisionLxc(
  opts: {
    template?: string
    ctidRange?: [number, number]
    towerHost?: string
    ssh?: SshRunner
  } = {},
): Promise<LxcHandle> {
  const template = opts.template ?? "debian-12-standard_12.12-1_amd64"
  const range = opts.ctidRange ?? [9100, 9199]
  const towerHost = opts.towerHost ?? process.env.TOWER_HOST ?? "tower"
  const ssh = opts.ssh ?? defaultSshRunner
  const suffix = Math.random().toString(36).slice(2, 8)
  const hostname = `vos-e2e-${suffix}`

  // List + create under retry. Two concurrent callers may compute the same ctid;
  // the create runs under flock and a collision (existing ctid) re-lists + re-picks.
  const MAX_ATTEMPTS = 3
  let lastErr = ""
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const listRes = await ssh(`root@${towerHost}`, `${PCT} list`, { timeoutMs: 30_000 })
    if (listRes.exitCode !== 0) {
      throw new Error(`provisionLxc: pct list failed: ${listRes.stderr || listRes.stdout}`)
    }
    const ctid = pickFreeCtid(listRes.stdout, range)

    const createCmd = `
flock ${LOCK} -c '
  set -e
  ${PCT} create ${ctid} local:vztmpl/${template}.tar.zst \\
    --hostname ${hostname} \\
    --memory 1024 --cores 2 --rootfs local-lvm:8 \\
    --features nesting=1 --unprivileged 1 \\
    --net0 name=eth0,bridge=vmbr0,ip=dhcp \\
    --start 1
  echo CTID=${ctid}
'
`
    const r = await ssh(`root@${towerHost}`, createCmd, { timeoutMs: 60_000 })
    if (r.exitCode === 0) {
      const m = r.stdout.match(/CTID=(\d+)/)
      if (!m) throw new Error(`provisionLxc: could not parse CTID from output: ${r.stdout}`)
      return { ctid: Number(m[1]), hostname, towerHost }
    }
    lastErr = r.stderr || r.stdout
    // Collision marker: pct create errors loudly when the ctid already exists.
    if (!/already exists|configuration file.*already/i.test(lastErr)) {
      throw new Error(`provisionLxc failed: ${lastErr}`)
    }
    // else: collision — loop, re-list, re-pick.
  }
  throw new Error(`provisionLxc: exhausted ${MAX_ATTEMPTS} attempts; last error: ${lastErr}`)
}

export async function lxcExec(
  h: LxcHandle,
  cmd: string,
  opts: {
    timeoutMs?: number
    allowFailure?: boolean
    ssh?: SshRunner
    input?: string
  } = {},
): Promise<ExecResult> {
  const ssh = opts.ssh ?? defaultSshRunner
  // base64 the cmd so quoting never breaks. Use process substitution `<(...)`
  // so the inner bash reads its script from a fifo and stdin stays bound to
  // ssh's stdin (a `| bash` pipe would consume stdin before the cmd sees it).
  const b64 = Buffer.from(cmd).toString("base64")
  const wrapped = `${PCT} exec ${h.ctid} -- bash -lc 'bash <(echo ${b64} | base64 -d)'`
  const r = await ssh(`root@${h.towerHost}`, wrapped, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    input: opts.input,
  })
  if (r.exitCode !== 0 && !opts.allowFailure) {
    throw new Error(
      `lxcExec failed (exit ${r.exitCode}) cmd=${cmd.slice(0, 120)}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
    )
  }
  return r
}

export async function waitForNet(h: LxcHandle, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    const r = await lxcExec(
      h,
      "getent hosts deb.debian.org >/dev/null && echo OK || echo NO",
      { allowFailure: true },
    )
    if (r.stdout.includes("OK")) return
    last = r.stdout + r.stderr
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error(`waitForNet timeout for CTID ${h.ctid}; last=${last}`)
}

export async function destroyLxc(h: LxcHandle, opts: { ssh?: SshRunner } = {}): Promise<void> {
  if (process.env.KEEP_LXC === "1") {
    console.warn(`KEEP_LXC=1 set; not destroying CTID ${h.ctid} (hostname ${h.hostname})`)
    return
  }
  const ssh = opts.ssh ?? defaultSshRunner
  await ssh(
    `root@${h.towerHost}`,
    `${PCT} stop ${h.ctid} --force || true; ${PCT} destroy ${h.ctid} --purge || true`,
    { timeoutMs: 30_000 },
  )
}
