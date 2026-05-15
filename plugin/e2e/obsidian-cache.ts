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

async function downloadAndExtract(cacheDir: string, appPath: string, version: string): Promise<void> {
  const url = buildDmgUrl(version);
  const dmgPath = path.join(cacheDir, `Obsidian-${version}.dmg`);
  const tmpDir = path.join(cacheDir, `.tmp-${process.pid}`);

  // 1. Download (Node fetch follows redirects by default; be explicit).
  const res = await fetch(url, { redirect: "follow" });
  assertDmgResponse(res, url);
  if (!res.body) throw new Error(`obsidian-cache: empty response body for ${url}`);
  // Stream to disk to avoid buffering ~140MB.
  const out = fs.createWriteStream(dmgPath);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) await new Promise<void>((resolve, reject) => out.write(value, (err) => (err ? reject(err) : resolve())));
  }
  await new Promise<void>((resolve, reject) => out.end((err: unknown) => (err ? reject(err) : resolve())));

  // 2. Mount.
  const att = spawnSync("hdiutil", ["attach", "-nobrowse", "-quiet", "-mountrandom", "/tmp", dmgPath], {
    encoding: "utf8",
  });
  if (att.status !== 0) {
    throw new Error(`obsidian-cache: hdiutil attach failed (exit ${att.status}): ${att.stderr}`);
  }
  // Last whitespace-separated field of the last non-empty line is the mount point.
  const mountPoint = att.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.trim().split(/\s+/).pop()!)
    .filter((p) => p.startsWith("/"))
    .pop();
  if (!mountPoint) {
    throw new Error(`obsidian-cache: could not parse hdiutil mount point from:\n${att.stdout}`);
  }

  // 3. Copy + atomic rename inside try/finally so we always detach.
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const srcApp = path.join(mountPoint, "Obsidian.app");
    if (!fs.existsSync(srcApp)) {
      throw new Error(`obsidian-cache: no Obsidian.app at mount ${mountPoint}`);
    }
    fs.cpSync(srcApp, path.join(tmpDir, "Obsidian.app"), { recursive: true });
  } finally {
    const det = spawnSync("hdiutil", ["detach", "-quiet", mountPoint], { encoding: "utf8" });
    if (det.status !== 0) {
      // Non-fatal: log to stderr, mount will be GC'd at reboot.
      console.warn(`obsidian-cache: hdiutil detach warning (exit ${det.status}): ${det.stderr}`);
    }
  }

  // 4. Unconditionally clear any stale appPath, then atomic rename.
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.renameSync(path.join(tmpDir, "Obsidian.app"), appPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dmgPath, { force: true });
}

export async function ensureObsidian(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      "obsidian-cache: macOS only; Linux follow-up pending (see VOS-94 spec).",
    );
  }
  const cacheDir = path.join(HERE, ".cache");
  const appPath = path.join(cacheDir, "Obsidian.app");
  const binPath = path.join(appPath, "Contents", "MacOS", "Obsidian");
  const versionFile = path.join(cacheDir, "VERSION");
  const lockDir = path.join(cacheDir, ".download.lock");

  fs.mkdirSync(cacheDir, { recursive: true });

  if (cacheIsValid(versionFile, binPath, OBSIDIAN_VERSION)) return binPath;

  await acquireLock(lockDir, 5 * 60_000);
  try {
    // Re-check inside the lock — another runner may have just finished.
    if (cacheIsValid(versionFile, binPath, OBSIDIAN_VERSION)) return binPath;

    await downloadAndExtract(cacheDir, appPath, OBSIDIAN_VERSION);
    fs.writeFileSync(versionFile, `${OBSIDIAN_VERSION}\n`);
    return binPath;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
