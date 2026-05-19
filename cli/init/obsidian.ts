import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import type { Prompter } from "./prompter"

export interface PromptObsidianOpts {
  vault: string
  platform?: NodeJS.Platform
  interactive?: boolean
  prompter: Prompter
  /** Test seam. */
  spawn?: (cmd: string, args: string[]) => SpawnSyncReturns<Buffer>
  /** Test seam — stdout sink. */
  log?: (msg: string) => void
  /** Test seam — warn sink. */
  warn?: (msg: string) => void
}

function obsidianUrl(vault: string): string {
  return `obsidian://open?path=${encodeURIComponent(vault)}`
}

export async function promptObsidian(opts: PromptObsidianOpts): Promise<void> {
  const log = opts.log ?? ((s) => console.log(s))
  const warn = opts.warn ?? ((s) => console.warn(s))
  const platform = opts.platform ?? process.platform
  const interactive = opts.interactive ?? true
  const url = obsidianUrl(opts.vault)

  if (!interactive || platform !== "darwin") {
    log(`Open ${opts.vault} in Obsidian: select "Open folder as vault" and point at ${opts.vault}`)
    log(`(or try: ${url} — only works if the vault is already registered)`)
    return
  }

  const yes = await opts.prompter.confirm({
    message: `Open ${opts.vault} in Obsidian now?`,
    initialValue: false,
  })
  if (!yes) return

  const spawn = opts.spawn ?? ((c, a) => spawnSync(c, a, { stdio: "ignore" }))
  // `open -a Obsidian <vault>` makes Obsidian prompt "open folder as vault" for
  // unregistered directories. The `obsidian://open?path=` URL scheme only
  // matches already-registered vaults and errors with "Vault not found"
  // otherwise, which is exactly the fresh-init case.
  const r = spawn("open", ["-a", "Obsidian", opts.vault])
  if (r.status !== 0) {
    warn(`open failed; launch Obsidian manually and select "Open folder as vault" pointing at ${opts.vault}`)
  }
}

export interface PrintNextStepsOpts {
  vault: string
  log?: (msg: string) => void
}

export function printNextSteps(opts: PrintNextStepsOpts): void {
  const log = opts.log ?? ((s) => console.log(s))
  log("")
  log("Next steps:")
  log("  Chat in Obsidian: open the vault, click the void-os ribbon.")
  log(`  Chat in CLI:      void-os daemon start --vault ${opts.vault} && void-os ask tinker "hi"`)
}
