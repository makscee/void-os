// VOS-120 T9-fix-A: route every node built-in through the lazy-require shim.
// Static `import "node:*"` is stripped by Bun's browser-target bundler — the
// Obsidian renderer would then crash on `homedir()` / `spawn()` undefined.
import { nodeFs, nodePath, nodeOs, nodeCp } from "./node-runtime";
const { statSync, constants, accessSync, readFileSync } = nodeFs;
const { join } = nodePath;
const pathResolve = nodePath.resolve;
const { homedir } = nodeOs;
const { spawn } = nodeCp;

export class BinaryNotFoundError extends Error {
  constructor() {
    super("void-os binary not found on PATH or well-known dirs");
  }
}

export class VaultMismatchError extends Error {
  readonly activeVault: string;
  constructor(activeVault: string) {
    super(`daemon already serves a different vault: ${activeVault}`);
    this.activeVault = activeVault;
  }
}

export class SpawnError extends Error {}
export class UnsupportedPlatformError extends Error {}

export type LifecycleSettings = {
  voidOsBinaryPath?: string;
  resolvedBinaryPath?: string;
};

type Env = { home: string; pathDirs: string[] };

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const WELL_KNOWN_SUBPATHS = [".bun/bin/void-os", ".local/bin/void-os"];
const WELL_KNOWN_ABSOLUTE = [
  "/opt/homebrew/bin/void-os",
  "/usr/local/bin/void-os",
];

async function loginShellWhich(timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", "command -v void-os"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
    });
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(null);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      const trimmed = out.trim();
      if (code === 0 && trimmed && isExecutable(trimmed)) resolve(trimmed);
      else resolve(null);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

export async function resolveBinary(
  settings: LifecycleSettings,
  env: Env = { home: homedir(), pathDirs: [] },
): Promise<string> {
  // 1. settings override
  if (
    settings.voidOsBinaryPath &&
    isExecutable(settings.voidOsBinaryPath)
  ) {
    return settings.voidOsBinaryPath;
  }
  // 2. cache
  if (
    settings.resolvedBinaryPath &&
    isExecutable(settings.resolvedBinaryPath)
  ) {
    return settings.resolvedBinaryPath;
  }
  // 3. login-shell probe — skipped in tests by env injection (empty pathDirs)
  if (env.pathDirs.length > 0) {
    const which = await loginShellWhich();
    if (which) return which;
  }
  // 4. well-known
  for (const sub of WELL_KNOWN_SUBPATHS) {
    const p = join(env.home, sub);
    if (isExecutable(p)) return p;
  }
  for (const p of WELL_KNOWN_ABSOLUTE) {
    if (isExecutable(p)) return p;
  }
  throw new BinaryNotFoundError();
}

export type HealthSnapshot = {
  ok: boolean;
  vault_root: string;
  version: string;
  port: number;
};

export type EnsureDaemonOpts = {
  vaultRoot: string;
  settings: LifecycleSettings;
  probeHealth: () => Promise<HealthSnapshot>;
  spawnCli: (bin: string, args: string[]) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type DaemonAttachment = {
  port: number;
  vault_root: string;
  version: string;
};

export async function ensureDaemon(opts: EnsureDaemonOpts): Promise<DaemonAttachment> {
  const intervalMs = opts.pollIntervalMs ?? 250;
  const timeoutMs = opts.pollTimeoutMs ?? 10000;

  // VOS-120 T9-fix-B: probe FIRST. If a daemon is already running and serving
  // the right vault, attach without ever needing to know where the binary
  // lives. This is the production-friendly path — Electron's renderer drops
  // PATH, so a `resolveBinary` call would fail before we ever ask the daemon
  // whether it's alive. Only when the probe fails do we bother resolving the
  // binary so we can spawn one. VaultMismatch always propagates immediately.
  try {
    const h = await opts.probeHealth();
    if (h.ok) {
      if (h.vault_root !== opts.vaultRoot) throw new VaultMismatchError(h.vault_root);
      return { port: h.port, vault_root: h.vault_root, version: h.version };
    }
  } catch (e) {
    if (e instanceof VaultMismatchError) throw e;
    // fall through to spawn
  }

  const bin = await resolveBinary(opts.settings);
  await opts.spawnCli(bin, ["daemon", "start", "--vault", opts.vaultRoot]);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await opts.probeHealth();
      if (h.ok) {
        if (h.vault_root !== opts.vaultRoot) throw new VaultMismatchError(h.vault_root);
        return { port: h.port, vault_root: h.vault_root, version: h.version };
      }
    } catch (e) {
      if (e instanceof VaultMismatchError) throw e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new SpawnError("daemon did not become ready within 10s");
}

/**
 * Read the daemon's listening port from the canonical JSON pidfile
 * (`~/.void-os/daemon.json`, written by the CLI per VOS-120). Falls back to
 * the legacy `daemon.port` text file for a single release. Returns null if
 * neither file exists or parsing fails.
 */
export function readDaemonPort(home: string): number | null {
  try {
    const raw = readFileSync(join(home, ".void-os", "daemon.json"), "utf8");
    const parsed = JSON.parse(raw) as { port?: unknown };
    return typeof parsed.port === "number" ? parsed.port : null;
  } catch {
    try {
      const legacy = readFileSync(
        join(home, ".void-os", "daemon.port"),
        "utf8",
      );
      const n = Number(legacy.trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
}

/**
 * Build a probeHealth callback bound to the user's home directory.
 *
 * /health is Bearer-auth gated (see daemon/src/auth/middleware.ts); the
 * shared secret lives in `~/.void-os/token` and is created by the daemon
 * on first boot. The probe reads it on each call so token rotation between
 * spawns is picked up immediately. Missing port or missing token both
 * surface as "not ready yet" — same shape as ECONNREFUSED so the
 * ensureDaemon poll loop just keeps waiting.
 *
 * Uses `fetch` (not Obsidian's `requestUrl`) so this module stays free of
 * the `obsidian` import — Bun's test runner cannot resolve `obsidian`
 * (it ships .d.ts only, no runtime module), which would otherwise break
 * the unit tests. CORS isn't a concern: `http://127.0.0.1:<port>` from
 * the Electron renderer is loopback-local and not subject to a preflight
 * (the daemon is a same-origin localhost peer for our purposes).
 */
export function makeProductionProbe(
  home: string,
): () => Promise<HealthSnapshot> {
  return async () => {
    const port = readDaemonPort(home);
    if (port == null) throw new Error("ECONNREFUSED");
    let token = "";
    try {
      token = readFileSync(join(home, ".void-os", "token"), "utf8").trim();
    } catch {
      throw new Error("ECONNREFUSED");
    }
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`health HTTP ${resp.status}`);
    const body = (await resp.json()) as {
      ok: boolean;
      vault_root: string;
      version: string;
    };
    return {
      ok: body.ok,
      vault_root: pathResolve(body.vault_root),
      version: body.version,
      port,
    };
  };
}

/**
 * Spawn the daemon detached so it outlives Obsidian. `detached: true` plus
 * `unref()` releases the child from the parent's event loop / process group;
 * `stdio: "ignore"` prevents the parent from holding the child's pipes open.
 */
export function makeProductionSpawn(): (
  bin: string,
  args: string[],
) => Promise<void> {
  return async (bin, args) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.unref();
  };
}
