import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

// VOS-116 lesson: Bun caches os.homedir() at startup; tests swap HOME per-case.
function home(): string {
  return process.env.HOME ?? os.homedir();
}

export function stateDir(): string {
  return path.join(home(), ".void-os");
}

export function tokenPath(): string { return path.join(stateDir(), "token"); }
export function pidPath(): string { return path.join(stateDir(), "daemon.pid"); }
export function portPath(): string { return path.join(stateDir(), "daemon.port"); }
export function logPath(): string { return path.join(stateDir(), "daemon.log"); }

export function ensureStateDir(): string {
  const d = stateDir();
  mkdirSync(d, { recursive: true });
  return d;
}

// VOS-120: JSON pidfile — supersedes daemon.pid + daemon.port (those stay one
// release as compat). Records enough to detect "already running for this vault"
// vs "running for a different vault" from a freshly-loaded Obsidian plugin.
export type DaemonPidJson = {
  pid: number;
  port: number;
  vault_root: string;
  version: string;
  started_at: string;
};

export function pidJsonPath(): string {
  return path.join(stateDir(), "daemon.json");
}

export function readPidJson(): DaemonPidJson | null {
  try {
    const raw = readFileSync(pidJsonPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.vault_root === "string" &&
      typeof parsed.version === "string" &&
      typeof parsed.started_at === "string"
    ) {
      return parsed as DaemonPidJson;
    }
    return null;
  } catch {
    return null;
  }
}

export function writePidJson(rec: DaemonPidJson): void {
  ensureStateDir();
  writeFileSync(pidJsonPath(), JSON.stringify(rec, null, 2));
}

export function removePidJson(): void {
  try {
    unlinkSync(pidJsonPath());
  } catch {
    /* ignore — idempotent */
  }
}
