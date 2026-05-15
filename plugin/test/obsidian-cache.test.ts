// VOS-94 — obsidian-cache unit tests.
import { describe, test, expect } from "bun:test";
import { OBSIDIAN_VERSION, ensureObsidian } from "../e2e/obsidian-cache";

describe("ensureObsidian platform guard", () => {
  test("non-darwin throws clear error naming the follow-up", async () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(ensureObsidian()).rejects.toThrow(/macOS only.*Linux follow-up/i);
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
  });

  test("exports a pinned version constant", () => {
    expect(OBSIDIAN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { cacheIsValid } from "../e2e/obsidian-cache";

describe("cacheIsValid", () => {
  function mkScratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voscache-test-"));
    const versionFile = path.join(dir, "VERSION");
    const binPath = path.join(dir, "Obsidian.app", "Contents", "MacOS", "Obsidian");
    return { dir, versionFile, binPath };
  }

  test("returns false when VERSION missing", () => {
    const { versionFile, binPath } = mkScratch();
    expect(cacheIsValid(versionFile, binPath, "1.8.10")).toBe(false);
  });

  test("returns false when binary missing", () => {
    const { dir, versionFile, binPath } = mkScratch();
    fs.writeFileSync(versionFile, "1.8.10\n");
    expect(cacheIsValid(versionFile, binPath, "1.8.10")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns false on version mismatch", () => {
    const { dir, versionFile, binPath } = mkScratch();
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "");
    fs.writeFileSync(versionFile, "1.8.9\n");
    expect(cacheIsValid(versionFile, binPath, "1.8.10")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns true when VERSION matches and binary present", () => {
    const { dir, versionFile, binPath } = mkScratch();
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "");
    fs.writeFileSync(versionFile, "1.8.10\n");
    expect(cacheIsValid(versionFile, binPath, "1.8.10")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import { isStaleLock } from "../e2e/obsidian-cache";

describe("isStaleLock", () => {
  function mkLockDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "voscache-lock-"));
  }

  test("returns false when lock dir does not exist", () => {
    const tmp = path.join(os.tmpdir(), `voscache-missing-${Date.now()}`);
    expect(isStaleLock(tmp, 60_000)).toBe(false);
  });

  test("returns false when lock fresh and no pidfile", () => {
    const lock = mkLockDir();
    try { expect(isStaleLock(lock, 60_000)).toBe(false); }
    finally { fs.rmSync(lock, { recursive: true, force: true }); }
  });

  test("returns true when mtime older than timeout window", () => {
    const lock = mkLockDir();
    const ancient = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, ancient, ancient);
    try { expect(isStaleLock(lock, 60_000)).toBe(true); }
    finally { fs.rmSync(lock, { recursive: true, force: true }); }
  });

  test("returns true when pidfile names a dead pid", () => {
    const lock = mkLockDir();
    // PID 1 is init/launchd; sending signal 0 from a non-root user fails with EPERM,
    // not ESRCH, so use a guaranteed-dead pid: fork a child, capture pid, wait, then probe.
    const child = spawnSyncNode(); // helper below
    fs.writeFileSync(path.join(lock, "pid"), String(child.pid));
    try { expect(isStaleLock(lock, 60_000)).toBe(true); }
    finally { fs.rmSync(lock, { recursive: true, force: true }); }
  });

  test("returns false when pidfile names a live pid", () => {
    const lock = mkLockDir();
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    try { expect(isStaleLock(lock, 60_000)).toBe(false); }
    finally { fs.rmSync(lock, { recursive: true, force: true }); }
  });
});

// Spawn a node child, wait for it to exit, return its pid. Guarantees ESRCH on later probe.
function spawnSyncNode(): { pid: number } {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (r.status !== 0) throw new Error("helper child failed");
  // r.pid is the now-exited pid.
  return { pid: r.pid! };
}
