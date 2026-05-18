import { existsSync, cpSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

export interface PluginOpts {
  prefix: string
  home: string
  dryRun: boolean
}

export interface PluginResult {
  installed: boolean
  target: string
  warnings: string[]
}

export interface EnsureBuiltResult {
  built: boolean
  /** `false` when plugin/dist already existed (no-op). */
  ran: boolean
  /** Non-empty when build was attempted and failed. */
  error?: string
}

/**
 * Ensure `<prefix>/plugin/dist` exists. If it doesn't, run `bun run build`
 * inside `<prefix>/plugin` (mirrors scripts/fresh-vault.sh). No-op on dry-run
 * or when the plugin source dir is missing. Captures stdout/stderr; the
 * caller is responsible for surfacing them on failure.
 */
export function ensurePluginBuilt(opts: {
  prefix: string
  dryRun: boolean
  /** Test seam: replace spawnSync. */
  spawn?: (cmd: string, args: string[], opts: { cwd: string }) => {
    status: number | null
    stdout?: Buffer | string
    stderr?: Buffer | string
  }
}): EnsureBuiltResult {
  const pluginDir = join(opts.prefix, "plugin")
  const distDir = join(pluginDir, "dist")
  if (existsSync(distDir)) return { built: true, ran: false }
  if (!existsSync(pluginDir)) return { built: false, ran: false }
  if (opts.dryRun) return { built: false, ran: false }

  const runner = opts.spawn ?? ((cmd, args, o) =>
    spawnSync(cmd, args, { cwd: o.cwd, encoding: "utf8" }))
  const r = runner("bun", ["run", "build"], { cwd: pluginDir })
  if (r.status === 0 && existsSync(distDir)) {
    return { built: true, ran: true }
  }
  const stderr = typeof r.stderr === "string" ? r.stderr : r.stderr?.toString() ?? ""
  const stdout = typeof r.stdout === "string" ? r.stdout : r.stdout?.toString() ?? ""
  return {
    built: false,
    ran: true,
    error: (stderr || stdout || `bun run build exited ${r.status}`).trim(),
  }
}

export function installPlugin(opts: PluginOpts): PluginResult {
  const src = join(opts.prefix, "plugin/dist")
  const target = join(opts.home, ".obsidian/plugins/void-os")
  const r: PluginResult = { installed: false, target, warnings: [] }

  if (!existsSync(src)) {
    r.warnings.push(
      `plugin build artifact missing at ${src}; vault will open in Obsidian without the void-os plugin`,
    )
    return r
  }

  if (!opts.dryRun) {
    cpSync(src, target, { recursive: true, force: true })
  }
  r.installed = true
  return r
}
