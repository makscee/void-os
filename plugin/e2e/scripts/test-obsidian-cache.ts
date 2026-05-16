#!/usr/bin/env bun
// VOS-94 — manual integration self-test for the Obsidian cache.
// Run from plugin/: `bun run e2e/scripts/test-obsidian-cache.ts`.
//
// Assertions:
//   1. Cold cache: ensureObsidian() downloads + extracts + returns a runnable binary.
//   2. Warm cache: second call is a no-op (<1s) and returns the same path.
//   3. Corrupted VERSION: function re-downloads.
//   4. Stale lock with dead pid: reclaimed within one poll interval.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureObsidian, OBSIDIAN_VERSION, isStaleLock } from "../obsidian-cache";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(HERE, "..", ".cache");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok — ${msg}`);
}

async function main() {
  console.log(`[1] Cold cache`);
  fs.rmSync(CACHE, { recursive: true, force: true });
  const t0 = Date.now();
  const bin = await ensureObsidian();
  console.log(`    download+extract took ${Math.round((Date.now() - t0) / 1000)}s`);
  assert(fs.existsSync(bin), `binary exists at ${bin}`);
  // Sanity: the binary should be a Mach-O executable.
  const file = spawnSync("file", [bin], { encoding: "utf8" });
  assert(/Mach-O/.test(file.stdout), `binary is Mach-O: ${file.stdout.trim()}`);

  console.log(`[2] Warm cache`);
  const t1 = Date.now();
  const bin2 = await ensureObsidian();
  const warmMs = Date.now() - t1;
  assert(bin === bin2, "returns same path");
  assert(warmMs < 500, `warm call fast (${warmMs}ms < 500ms)`);

  console.log(`[3] Corrupted VERSION → re-download`);
  fs.writeFileSync(path.join(CACHE, "VERSION"), "0.0.0\n");
  const t2 = Date.now();
  await ensureObsidian();
  assert(fs.readFileSync(path.join(CACHE, "VERSION"), "utf8").trim() === OBSIDIAN_VERSION,
    "VERSION restored after corruption");
  console.log(`    re-download took ${Math.round((Date.now() - t2) / 1000)}s`);

  console.log(`[4] Stale lock reclaim`);
  // Invalidate cache + plant stale lock — forces ensureObsidian through acquireLock.
  const lock = path.join(CACHE, ".download.lock");
  fs.writeFileSync(path.join(CACHE, "VERSION"), "0.0.0\n");
  fs.mkdirSync(lock);
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  fs.writeFileSync(path.join(lock, "pid"), String(dead.pid));
  assert(isStaleLock(lock, 60_000), "isStaleLock detects dead pid");
  await ensureObsidian(); // reclaims lock, re-downloads
  assert(!fs.existsSync(lock), "stale lock cleared after ensureObsidian");
  assert(fs.readFileSync(path.join(CACHE, "VERSION"), "utf8").trim() === OBSIDIAN_VERSION,
    "VERSION restored after stale-lock reclaim");

  console.log("\nALL CHECKS PASSED");
}

main().catch((err) => { console.error(err); process.exit(1); });
