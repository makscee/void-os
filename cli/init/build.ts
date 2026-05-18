import { spawnSync } from "node:child_process"
import { existsSync, statSync, readdirSync } from "node:fs"
import { join } from "node:path"

export class BuildError extends Error {
  constructor(msg: string, public exitCode = 3) { super(msg) }
}

export function needsPluginBuild(prefix: string): boolean {
  const dist = join(prefix, "plugin/dist/main.js")
  if (!existsSync(dist)) return true

  const distMtime = statSync(dist).mtimeMs
  const checkPaths = [
    join(prefix, "plugin/package.json"),
    join(prefix, "plugin/bun.lock"),
  ]
  const srcDir = join(prefix, "plugin/src")
  if (existsSync(srcDir)) {
    for (const f of walkFiles(srcDir)) checkPaths.push(f)
  }
  for (const p of checkPaths) {
    if (!existsSync(p)) continue
    if (statSync(p).mtimeMs > distMtime) return true
  }
  return false
}

function* walkFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkFiles(p)
    else yield p
  }
}

export interface BuildOpts {
  prefix: string
  skipBuild: boolean
  spawnSync?: typeof spawnSync
}

export function runBuild(opts: BuildOpts): void {
  if (opts.skipBuild) return
  const spawn = opts.spawnSync ?? spawnSync

  const rootInstall = spawn("bun", ["install"], { cwd: opts.prefix, stdio: "inherit" })
  if (rootInstall.status !== 0) throw new BuildError("bun install (root) failed")

  const pluginDir = join(opts.prefix, "plugin")
  const pluginInstall = spawn("bun", ["install"], { cwd: pluginDir, stdio: "inherit" })
  if (pluginInstall.status !== 0) throw new BuildError("bun install (plugin) failed")

  if (needsPluginBuild(opts.prefix)) {
    // plugin/build.ts defaults `out` to ~/void/.obsidian/plugins/void-os
    // (dev-loop convenience). Pin VOID_OS_PLUGIN_OUT to <prefix>/plugin/dist
    // so the artifacts land where installPlugin/ensurePluginBuilt expect them.
    const distDir = join(pluginDir, "dist")
    const pluginBuild = spawn("bun", ["run", "build"], {
      cwd: pluginDir,
      stdio: "inherit",
      env: { ...process.env, VOID_OS_PLUGIN_OUT: distDir },
    })
    if (pluginBuild.status !== 0) throw new BuildError("plugin build failed")
  }
}
