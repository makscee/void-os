import { existsSync, cpSync } from "node:fs"
import { join } from "node:path"

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
