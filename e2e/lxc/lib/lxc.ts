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
  opts?: { timeoutMs?: number },
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

export const defaultSshRunner: SshRunner = (host, cmd, opts) =>
  new Promise((resolve) => {
    const p = spawn("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      host,
      cmd,
    ])
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
  const template = opts.template ?? "debian-12-standard"
  const range = opts.ctidRange ?? [9100, 9199]
  const towerHost = opts.towerHost ?? process.env.TOWER_HOST ?? "tower"
  const ssh = opts.ssh ?? defaultSshRunner
  const suffix = Math.random().toString(36).slice(2, 8)
  const hostname = `vos-e2e-${suffix}`

  // Pick + create under flock to serialize concurrent callers.
  const pickAndCreate = `
flock ${LOCK} -c '
  list=$(${PCT} list)
  ctid=$(echo "$list" | awk "NR>1 && \\$1 >= ${range[0]} && \\$1 <= ${range[1]} {print \\$1}" | sort -n | tail -1)
  if [ -z "$ctid" ]; then ctid=${range[0]}; else ctid=$((ctid + 1)); fi
  if [ "$ctid" -gt ${range[1]} ]; then echo "no free CTID" >&2; exit 1; fi
  ${PCT} create $ctid local:vztmpl/${template}.tar.zst \\
    --hostname ${hostname} \\
    --memory 1024 --cores 2 --rootfs local-lvm:8 \\
    --features nesting=1 --unprivileged 1 \\
    --net0 name=eth0,bridge=vmbr0,ip=dhcp \\
    --start 1
  echo CTID=$ctid
'
`
  const r = await ssh(`root@${towerHost}`, pickAndCreate, { timeoutMs: 60_000 })
  if (r.exitCode !== 0) {
    throw new Error(`provisionLxc failed: ${r.stderr || r.stdout}`)
  }
  const m = r.stdout.match(/CTID=(\d+)/)
  if (!m) throw new Error(`provisionLxc: could not parse CTID from output: ${r.stdout}`)
  return { ctid: Number(m[1]), hostname, towerHost }
}

export async function lxcExec(
  h: LxcHandle,
  cmd: string,
  opts: { timeoutMs?: number; allowFailure?: boolean; ssh?: SshRunner } = {},
): Promise<ExecResult> {
  const ssh = opts.ssh ?? defaultSshRunner
  // base64 the cmd so quoting never breaks.
  const b64 = Buffer.from(cmd).toString("base64")
  const wrapped = `${PCT} exec ${h.ctid} -- bash -lc "echo ${b64} | base64 -d | bash"`
  const r = await ssh(`root@${h.towerHost}`, wrapped, { timeoutMs: opts.timeoutMs ?? 60_000 })
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
