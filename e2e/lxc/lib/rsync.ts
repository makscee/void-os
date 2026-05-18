import { spawn } from "node:child_process"
import { PCT, type LxcHandle } from "./lxc"

const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist", "tmp", "*.log"]

function runCmd(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args)
    let stdout = ""
    let stderr = ""
    p.stdout.on("data", (d) => {
      stdout += d.toString()
    })
    p.stderr.on("data", (d) => {
      stderr += d.toString()
    })
    let timed = false
    const t = opts.timeoutMs
      ? setTimeout(() => {
          timed = true
          p.kill("SIGKILL")
        }, opts.timeoutMs)
      : null
    p.on("close", (c) => {
      if (t) clearTimeout(t)
      resolve({ exitCode: timed ? 124 : c ?? -1, stderr, stdout })
    })
  })
}

// Sync localPath into the LXC at destPath via tower as a hop.
// Pipeline: rsync host→tower:/tmp/stage, tar+pct-push+untar inside the LXC.
export async function rsyncIntoLxc(
  localPath: string,
  h: LxcHandle,
  destPath: string,
  excludes: string[] = DEFAULT_EXCLUDES,
): Promise<void> {
  const stagingDir = `/tmp/vos-e2e-stage-${h.ctid}`
  // 1. rsync localPath → tower:stagingDir
  const exFlags = excludes.flatMap((e) => ["--exclude", e])
  const r1 = await runCmd(
    "rsync",
    ["-aH", "--delete", ...exFlags, `${localPath}/`, `root@${h.towerHost}:${stagingDir}/`],
    { timeoutMs: 120_000 },
  )
  if (r1.exitCode !== 0) throw new Error(`rsync host→tower failed: ${r1.stderr}`)

  // 2. tar the staging dir on tower, pct push tar into the LXC, untar.
  const tarName = `vos-e2e-${h.ctid}.tar.gz`
  const cmd = [
    `tar -czf /tmp/${tarName} -C ${stagingDir} .`,
    `${PCT} push ${h.ctid} /tmp/${tarName} /tmp/${tarName}`,
    `${PCT} exec ${h.ctid} -- bash -c 'mkdir -p ${destPath} && tar -xzf /tmp/${tarName} -C ${destPath} && rm /tmp/${tarName}'`,
    `rm /tmp/${tarName}`,
    `rm -rf ${stagingDir}`,
  ].join(" && ")
  const r2 = await runCmd(
    "ssh",
    ["-o", "BatchMode=yes", `root@${h.towerHost}`, cmd],
    { timeoutMs: 60_000 },
  )
  if (r2.exitCode !== 0) throw new Error(`pct push/untar failed: ${r2.stderr}`)
}
