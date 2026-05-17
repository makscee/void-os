import { statSync, constants, accessSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

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
