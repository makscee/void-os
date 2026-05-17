import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync } from "node:fs";

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
