import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
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
    const enableWarn = enablePluginInVault(opts.home)
    if (enableWarn) r.warnings.push(enableWarn)
  }
  r.installed = true
  return r
}

/**
 * Seed `<vault>/.obsidian/community-plugins.json` so Obsidian auto-enables
 * the void-os plugin on first vault open. Without this, fresh-installed
 * vaults require the operator to walk Settings → Community plugins →
 * Enable "void-os" by hand.
 *
 * Idempotent merge:
 *   - missing file or malformed JSON → write `["void-os"]`
 *   - existing JSON array without "void-os" → append
 *   - existing JSON array with "void-os" → no-op
 *
 * Safe-on-error: returns a warning string instead of throwing, so a
 * disk-full / permission-denied case doesn't abort init.
 */
export function enablePluginInVault(vaultPath: string): string | undefined {
  const dir = join(vaultPath, ".obsidian")
  const file = join(dir, "community-plugins.json")
  try {
    mkdirSync(dir, { recursive: true })
    let plugins: string[] = ["void-os"]
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
        if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
          const arr = parsed as string[]
          if (arr.includes("void-os")) return undefined // no-op
          plugins = [...arr, "void-os"]
        }
        // else: malformed (not an array of strings) → overwrite below
      } catch {
        // malformed JSON → overwrite below
      }
    }
    writeFileSync(file, JSON.stringify(plugins, null, 2))
    return undefined
  } catch (e) {
    return `could not write ${file}: ${(e as Error).message}; enable void-os manually via Settings → Community plugins`
  }
}
