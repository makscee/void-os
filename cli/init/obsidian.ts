import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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
  /** Test seam — detect already-running Obsidian. */
  isObsidianRunning?: () => boolean
  /** Test seam — override HOME for registration JSON path. */
  homeDir?: () => string
}

function obsidianUrl(vault: string): string {
  return `obsidian://open?path=${encodeURIComponent(vault)}`
}

function obsidianUserDataDir(platform: NodeJS.Platform, home: string): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "obsidian")
  }
  // linux fallback for completeness; we don't currently call this on linux.
  return path.join(home, ".config", "obsidian")
}

export interface RegisterObsidianVaultOpts {
  platform?: NodeJS.Platform
  homeDir?: () => string
}

/**
 * Merge-register `vault` into Obsidian's prefs file so `open -a Obsidian`
 * launches into it. Other registered vaults are preserved but flipped to
 * `open: false` (only one vault can be the launch target).
 *
 * Atomic write: temp file in the same dir + rename. Malformed existing JSON
 * is treated as `{}`. Top-level keys other than `vaults` are preserved.
 */
export function registerObsidianVault(vault: string, opts: RegisterObsidianVaultOpts = {}): void {
  const platform = opts.platform ?? process.platform
  const home = (opts.homeDir ?? (() => os.homedir()))()
  const absVault = path.resolve(vault)
  const vaultId = crypto.createHash("md5").update(absVault).digest("hex").slice(0, 16)
  const dir = obsidianUserDataDir(platform, home)
  const file = path.join(dir, "obsidian.json")

  fs.mkdirSync(dir, { recursive: true })

  let parsed: Record<string, unknown> = {}
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf8")
      const candidate = JSON.parse(raw)
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      // Malformed — treat as empty.
      parsed = {}
    }
  }

  const vaultsField = parsed.vaults
  const vaults: Record<string, Record<string, unknown>> =
    vaultsField && typeof vaultsField === "object" && !Array.isArray(vaultsField)
      ? (vaultsField as Record<string, Record<string, unknown>>)
      : {}

  // Flip any other currently-open vault to closed; only one can auto-open.
  for (const key of Object.keys(vaults)) {
    if (key === vaultId) continue
    const entry = vaults[key]
    if (entry && typeof entry === "object" && entry.open === true) {
      entry.open = false
    }
  }

  vaults[vaultId] = {
    path: absVault,
    ts: Date.now(),
    open: true,
    trusted: true,
  }

  parsed.vaults = vaults

  const tmp = path.join(dir, `obsidian.json.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2))
  fs.renameSync(tmp, file)
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
  const isObsidianRunning =
    opts.isObsidianRunning ??
    (() => spawnSync("pgrep", ["-x", "Obsidian"], { stdio: "ignore" }).status === 0)

  // Register the vault in Obsidian's prefs so it's listed in the vault picker
  // and so `open -a Obsidian` (no path arg) auto-opens it on launch.
  try {
    registerObsidianVault(opts.vault, { platform, homeDir: opts.homeDir })
  } catch (err) {
    warn(`failed to register vault in obsidian.json: ${(err as Error).message}`)
    return
  }

  if (isObsidianRunning()) {
    // macOS LaunchServices won't switch vaults if Obsidian is already running —
    // `open -a Obsidian` (with or without a path) just focuses the existing
    // window. Skip the spawn and tell the operator how to switch.
    log(`Obsidian is already running. The vault is registered — switch via File → Open Vault, or restart Obsidian to auto-open ${opts.vault}.`)
    return
  }

  // Not running: launch Obsidian. It reads obsidian.json on startup and opens
  // the vault flagged `open: true` (which we just set).
  const r = spawn("open", ["-a", "Obsidian"])
  if (r.status !== 0) {
    warn(`open failed; launch Obsidian manually and select the vault at ${opts.vault}`)
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
