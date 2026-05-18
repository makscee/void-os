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

/** Required artifact filenames inside `<prefix>/plugin/dist` post-build. */
export const PLUGIN_DIST_FILES = ["main.js", "manifest.json", "styles.css"] as const

/**
 * Build environment + command for the plugin pre-build. Factored out so the
 * exact env/cwd/cmd can be unit-tested without spawning bun. `plugin/build.ts`
 * defaults `out` to `~/void/.obsidian/plugins/void-os` (a dev-loop
 * convenience), so we MUST pin `VOID_OS_PLUGIN_OUT` to `<prefix>/plugin/dist`
 * for `installPlugin` to find the artifacts afterwards.
 */
export function pluginBuildEnv(prefix: string): {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  distDir: string
} {
  const pluginDir = join(prefix, "plugin")
  const distDir = join(pluginDir, "dist")
  return {
    cmd: "bun",
    args: ["run", "build"],
    cwd: pluginDir,
    env: { ...process.env as Record<string, string>, VOID_OS_PLUGIN_OUT: distDir },
    distDir,
  }
}

/**
 * Ensure `<prefix>/plugin/dist` exists with the expected artifacts. If not,
 * run `bun run build` inside `<prefix>/plugin` with `VOID_OS_PLUGIN_OUT`
 * pinned to that path (mirrors scripts/fresh-vault.sh). No-op on dry-run or
 * when the plugin source dir is missing. Success requires both exit==0 AND
 * all PLUGIN_DIST_FILES present — stderr noise alone is NOT a failure.
 */
export function ensurePluginBuilt(opts: {
  prefix: string
  dryRun: boolean
  /** Test seam: replace spawnSync. Receives env so tests can assert it. */
  spawn?: (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => {
    status: number | null
    stdout?: Buffer | string
    stderr?: Buffer | string
  }
}): EnsureBuiltResult {
  const { cmd, args, cwd, env, distDir } = pluginBuildEnv(opts.prefix)
  const pluginDir = cwd
  // Already built? Trust dist only if the key artifacts are present.
  if (existsSync(distDir) && PLUGIN_DIST_FILES.every((f) => existsSync(join(distDir, f)))) {
    return { built: true, ran: false }
  }
  if (!existsSync(pluginDir)) return { built: false, ran: false }
  if (opts.dryRun) return { built: false, ran: false }

  const runner = opts.spawn ?? ((c, a, o) =>
    spawnSync(c, a, { cwd: o.cwd, env: o.env, encoding: "utf8" }))
  const r = runner(cmd, args, { cwd, env })
  const filesPresent = PLUGIN_DIST_FILES.every((f) => existsSync(join(distDir, f)))
  if (r.status === 0 && filesPresent) {
    return { built: true, ran: true }
  }
  const stderr = typeof r.stderr === "string" ? r.stderr : r.stderr?.toString() ?? ""
  const stdout = typeof r.stdout === "string" ? r.stdout : r.stdout?.toString() ?? ""
  const missing = PLUGIN_DIST_FILES.filter((f) => !existsSync(join(distDir, f)))
  const reason = r.status !== 0
    ? `bun run build exited ${r.status}`
    : `bun run build succeeded but missing: ${missing.join(", ")}`
  return {
    built: false,
    ran: true,
    error: `${reason}${stderr || stdout ? `\n${(stderr || stdout).trim()}` : ""}`.trim(),
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
