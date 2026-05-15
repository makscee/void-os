// VOS-94 — local Obsidian binary cache.
// See docs/superpowers/specs/2026-05-15-vos-94-e2e-obsidian-cache-design.md
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const OBSIDIAN_VERSION = "1.8.10";

export function cacheIsValid(versionFile: string, binPath: string, expected: string): boolean {
  if (!fs.existsSync(versionFile) || !fs.existsSync(binPath)) return false;
  return fs.readFileSync(versionFile, "utf8").trim() === expected;
}

export function isStaleLock(lockDir: string, timeoutMs: number): boolean {
  const stat = fs.statSync(lockDir, { throwIfNoEntry: false });
  if (!stat) return false;
  if (Date.now() - stat.mtimeMs > timeoutMs) return true;
  const pidPath = path.join(lockDir, "pid");
  if (!fs.existsSync(pidPath)) return false;
  const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;                   // alive (or EPERM — treat as alive)
  } catch (e: any) {
    return e?.code === "ESRCH";     // ESRCH = no such process → stale
  }
}

export async function acquireLock(lockDir: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let staleRetried = false;
  while (Date.now() - start < timeoutMs) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
      return;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (!staleRetried && isStaleLock(lockDir, timeoutMs)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        staleRetried = true;
        continue;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `obsidian-cache: lock timeout after ${timeoutMs}ms (stale ${lockDir}?). ` +
      `Delete plugin/e2e/.cache/.download.lock if no other run is active.`,
  );
}

export function buildDmgUrl(version: string): string {
  return `https://github.com/obsidianmd/obsidian-releases/releases/download/v${version}/Obsidian-${version}.dmg`;
}

export function assertDmgResponse(res: Response, url: string): void {
  if (!res.ok) {
    throw new Error(`obsidian-cache: download failed: HTTP ${res.status} for ${url} (final url: ${res.url || url})`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("octet-stream")) {
    throw new Error(`obsidian-cache: unexpected content-type "${ct}" for ${url} — redirect may have dropped to HTML`);
  }
}

export async function ensureObsidian(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      "obsidian-cache: macOS only; Linux follow-up pending (see VOS-94 spec).",
    );
  }
  throw new Error("obsidian-cache: not implemented");
}
