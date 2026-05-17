import type { PreflightReport } from "./preflight"
import type { Decisions } from "./configure"
import type { PluginResult } from "./plugin"

/**
 * Minimal shape of the seed-phase result the report consumes.
 * Defined here (vs imported from ./seed) so this module compiles + tests
 * independently of the concurrently-developed seed module. The seed module
 * is expected to export a result type compatible with this shape.
 */
export interface SeedResultLike {
  isFreshSeed: boolean
  gh: {
    pushed: boolean
    remote?: string
    warning?: string
  }
}

export interface ReportInput {
  vaultPath: string
  preflight: PreflightReport
  decisions: Decisions
  seed: SeedResultLike
  plugin: PluginResult
}

export function formatReport(r: ReportInput): string {
  const lines: string[] = []
  const fresh = r.seed.isFreshSeed
  const headline = fresh
    ? `void-os seeded at ${r.vaultPath}`
    : `void-os already seeded at ${r.vaultPath}; re-applied build + plugin only`

  lines.push(headline)
  if (fresh) {
    lines.push("  • git initialized + first commit")
  }
  if (r.seed.gh.pushed && r.seed.gh.remote) {
    lines.push(`  • pushed to ${r.seed.gh.remote}`)
  } else if (r.decisions.gh.push && r.seed.gh.warning) {
    lines.push(`  • gh push skipped: ${r.seed.gh.warning}`)
  } else if (!r.decisions.gh.push) {
    lines.push("  • remote: none (add later with `gh repo create`)")
  }
  if (r.plugin.installed) {
    lines.push("  • plugin copied to .obsidian/plugins/void-os/")
  } else {
    lines.push("  • plugin: not installed (build artifact missing)")
  }

  lines.push("")
  lines.push("next:")
  if (r.preflight.obsidian.found) {
    lines.push(`  1. open Obsidian, "Open vault" → ${r.vaultPath}`)
    lines.push(`  2. Settings → Community plugins → enable "void-os"`)
    lines.push(`  3. chat with Tinker via the plugin's chat pane`)
  } else {
    lines.push(`  1. install Obsidian: https://obsidian.md`)
    lines.push(`  2. open vault at ${r.vaultPath}, enable void-os plugin`)
  }
  lines.push("")
  lines.push('CLI access (`void-os ask tinker "hello"`) lands with VOS-118.')

  if (!fresh) {
    lines.push("")
    lines.push("(Pass --force to re-seed templates.)")
  }
  return lines.join("\n")
}
