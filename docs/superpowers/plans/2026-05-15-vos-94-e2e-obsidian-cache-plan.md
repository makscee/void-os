# VOS-94 — e2e Obsidian Binary Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Playwright e2e harness owns its own Obsidian binary under `plugin/e2e/.cache/` (gitignored, downloaded on first run, reused after), so it stops depending on the developer's `/Applications/Obsidian.app`.

**Architecture:** New module `plugin/e2e/obsidian-cache.ts` exports `ensureObsidian(): Promise<string>` returning the absolute path to a usable Obsidian binary. It checks a `.cache/VERSION` marker, takes a lockdir if missing, downloads the pinned `Obsidian-${VERSION}.dmg` from GitHub releases, mounts via `hdiutil`, copies `Obsidian.app` to a `.tmp-<pid>` staging dir, then atomically renames into `.cache/Obsidian.app`. Crash recovery is automatic via pid + mtime stale-lock heuristic. `globalSetup.ts` calls it once and feeds the path to `spawn`.

**Tech Stack:** TypeScript, Bun runtime, `node:fs`/`node:child_process`/`node:path`, Node `fetch` (undici), macOS `hdiutil`, Playwright `globalSetup`, `bun:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-05-15-vos-94-e2e-obsidian-cache-design.md`

**Repo / branch:** `~/void-os` on `task/VOS-94` (already created; spec committed).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `plugin/e2e/obsidian-cache.ts` | **Create** | Module: `OBSIDIAN_VERSION`, `ensureObsidian()`, internal helpers (`cacheIsValid`, `acquireLock`, `isStaleLock`, `downloadAndExtract`, `buildDmgUrl`) |
| `plugin/e2e/globalSetup.ts` | **Modify** | Import + call `ensureObsidian()`; replace hardcoded `/Applications/...` spawn target (line 154) |
| `plugin/e2e/.gitignore` | **Modify** | Add `.cache/` |
| `plugin/e2e/playwright.config.ts` | **Modify** | Add `globalTimeout: 5 * 60_000` so first-run downloads fit |
| `plugin/e2e/README.md` | **Modify** | Append `### Obsidian binary cache` section; update prereqs (no `/Applications/Obsidian.app` requirement) |
| `plugin/test/obsidian-cache.test.ts` | **Create** | `bun:test` unit tests for the pure helpers (URL builder, `cacheIsValid`, `isStaleLock`, lock contention) |
| `plugin/e2e/scripts/test-obsidian-cache.ts` | **Create** | Manual integration self-test: cold download, no-op, stale-lock reclaim |

**Decomposition rationale:** the cache module has one job — hand back a binary path. Splitting download/extract into a sub-file is overkill at ~150 LOC. Tests split by speed: fast pure-unit tests in `plugin/test/` (runs with the regular `bun test`); a separate hand-run integration script for the network/disk path so CI doesn't accidentally pay the DMG cost.

---

## Conventions used throughout

- All commits are made from inside `~/void-os` on branch `task/VOS-94`. The first task includes a `git status` sanity check to confirm.
- Test commands run from `plugin/`: `cd plugin && bun test path/to/file.test.ts -t "name"`.
- Imports use the project's existing `import * as fs from "node:fs"` style (see `plugin/e2e/globalSetup.ts`).
- TDD: failing test first, then implementation, then commit. One commit per task unless noted.

---

## Task 1: Scaffold `obsidian-cache.ts` with platform guard

**Files:**
- Create: `plugin/e2e/obsidian-cache.ts`
- Create: `plugin/test/obsidian-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugin/test/obsidian-cache.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugin && bun test test/obsidian-cache.test.ts
```

Expected: FAIL — `Cannot find module '../e2e/obsidian-cache'`.

- [ ] **Step 3: Create the module skeleton**

Create `plugin/e2e/obsidian-cache.ts`:

```ts
// VOS-94 — local Obsidian binary cache.
// See docs/superpowers/specs/2026-05-15-vos-94-e2e-obsidian-cache-design.md
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const OBSIDIAN_VERSION = "1.8.10";

export async function ensureObsidian(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      "obsidian-cache: macOS only; Linux follow-up pending (see VOS-94 spec).",
    );
  }
  throw new Error("obsidian-cache: not implemented");
}
```

- [ ] **Step 4: Run test to verify the guard test passes**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "platform guard"
```

Expected: 2 pass (`non-darwin throws…`, `exports a pinned version constant`).

- [ ] **Step 5: Commit**

```bash
cd ~/void-os
git add plugin/e2e/obsidian-cache.ts plugin/test/obsidian-cache.test.ts
git commit -m "feat(VOS-94): scaffold obsidian-cache module + platform guard"
```

---

## Task 2: `cacheIsValid` helper

**Files:**
- Modify: `plugin/e2e/obsidian-cache.ts`
- Modify: `plugin/test/obsidian-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugin/test/obsidian-cache.test.ts`:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "cacheIsValid"
```

Expected: FAIL — `cacheIsValid` not exported.

- [ ] **Step 3: Implement `cacheIsValid`**

Add to `plugin/e2e/obsidian-cache.ts` (above `ensureObsidian`):

```ts
export function cacheIsValid(versionFile: string, binPath: string, expected: string): boolean {
  if (!fs.existsSync(versionFile) || !fs.existsSync(binPath)) return false;
  return fs.readFileSync(versionFile, "utf8").trim() === expected;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "cacheIsValid"
```

Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
cd ~/void-os
git add plugin/e2e/obsidian-cache.ts plugin/test/obsidian-cache.test.ts
git commit -m "feat(VOS-94): cacheIsValid helper"
```

---

## Task 3: `isStaleLock` heuristic

**Files:**
- Modify: `plugin/e2e/obsidian-cache.ts`
- Modify: `plugin/test/obsidian-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugin/test/obsidian-cache.test.ts`:

```ts
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
```

Add to existing top imports of the test file (or merge):

```ts
import { spawnSync } from "node:child_process";
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "isStaleLock"
```

Expected: FAIL — `isStaleLock` not exported.

- [ ] **Step 3: Implement `isStaleLock`**

Add to `plugin/e2e/obsidian-cache.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "isStaleLock"
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
cd ~/void-os
git add plugin/e2e/obsidian-cache.ts plugin/test/obsidian-cache.test.ts
git commit -m "feat(VOS-94): isStaleLock heuristic (pid liveness + mtime fallback)"
```

---

## Task 4: `acquireLock` with stale reclaim

**Files:**
- Modify: `plugin/e2e/obsidian-cache.ts`
- Modify: `plugin/test/obsidian-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugin/test/obsidian-cache.test.ts`:

```ts
import { acquireLock } from "../e2e/obsidian-cache";

describe("acquireLock", () => {
  test("acquires fresh lock and writes pidfile", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "voscache-acq-"));
    const lockDir = path.join(cacheDir, ".download.lock");
    try {
      await acquireLock(lockDir, 5_000);
      expect(fs.existsSync(lockDir)).toBe(true);
      expect(fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("times out when an already-locked dir is owned by a live foreign pid", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "voscache-acq2-"));
    const lockDir = path.join(cacheDir, ".download.lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid)); // self = live
    try {
      const start = Date.now();
      await expect(acquireLock(lockDir, 1_500)).rejects.toThrow(/lock timeout/);
      expect(Date.now() - start).toBeGreaterThanOrEqual(1_500);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("reclaims a stale (dead-pid) lock once", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "voscache-acq3-"));
    const lockDir = path.join(cacheDir, ".download.lock");
    fs.mkdirSync(lockDir);
    const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(path.join(lockDir, "pid"), String(r.pid));
    try {
      await acquireLock(lockDir, 5_000);
      expect(fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "acquireLock"
```

Expected: FAIL — `acquireLock` not exported.

- [ ] **Step 3: Implement `acquireLock`**

Add to `plugin/e2e/obsidian-cache.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "acquireLock"
```

Expected: 3 pass (note: second test sleeps 1.5s — that's expected).

- [ ] **Step 5: Commit**

```bash
cd ~/void-os
git add plugin/e2e/obsidian-cache.ts plugin/test/obsidian-cache.test.ts
git commit -m "feat(VOS-94): acquireLock with stale-pid reclaim"
```

---

## Task 5: `buildDmgUrl` + content-type guard helpers

**Files:**
- Modify: `plugin/e2e/obsidian-cache.ts`
- Modify: `plugin/test/obsidian-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugin/test/obsidian-cache.test.ts`:

```ts
import { buildDmgUrl, assertDmgResponse } from "../e2e/obsidian-cache";

describe("buildDmgUrl", () => {
  test("matches the GitHub releases asset URL pattern", () => {
    expect(buildDmgUrl("1.8.10")).toBe(
      "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.8.10/Obsidian-1.8.10.dmg",
    );
  });
});

describe("assertDmgResponse", () => {
  test("throws on non-ok response", () => {
    const r = new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
    expect(() => assertDmgResponse(r, "https://x")).toThrow(/HTTP 404/);
  });

  test("throws when content-type is not octet-stream", () => {
    const r = new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(() => assertDmgResponse(r, "https://x")).toThrow(/content-type/i);
  });

  test("passes for octet-stream + 200", () => {
    const r = new Response("\0\0\0", { status: 200, headers: { "content-type": "application/octet-stream" } });
    expect(() => assertDmgResponse(r, "https://x")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "buildDmgUrl"
```

Expected: FAIL — `buildDmgUrl` / `assertDmgResponse` not exported.

- [ ] **Step 3: Implement the helpers**

Add to `plugin/e2e/obsidian-cache.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd plugin && bun test test/obsidian-cache.test.ts -t "buildDmgUrl|assertDmgResponse"
```

Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
cd ~/void-os
git add plugin/e2e/obsidian-cache.ts plugin/test/obsidian-cache.test.ts
git commit -m "feat(VOS-94): URL builder + DMG response guard"
```

---

## Task 6: `downloadAndExtract` (network + hdiutil) + full `ensureObsidian`

**Files:**
- Modify: `plugin/e2e/obsidian-cache.ts`

No unit tests in this task — the function is pure I/O. It's exercised by the integration self-test in Task 7.

- [ ] **Step 1: Implement `downloadAndExtract`**

Append to `plugin/e2e/obsidian-cache.ts` (above `ensureObsidian`):

```ts
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
```

- [ ] **Step 2: Wire `ensureObsidian` to call the helpers**

Replace the `ensureObsidian` body in `plugin/e2e/obsidian-cache.ts`:

```ts
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
```

- [ ] **Step 3: Run unit tests to verify nothing regressed**

```bash
cd plugin && bun test test/obsidian-cache.test.ts
```

Expected: all prior tests still pass (14+ tests across the previous five tasks).

- [ ] **Step 4: Commit**

```bash
cd ~/void-os
git add plugin/e2e/obsidian-cache.ts
git commit -m "feat(VOS-94): downloadAndExtract + full ensureObsidian wiring"
```

---

## Task 7: Manual integration self-test script

**Files:**
- Create: `plugin/e2e/scripts/test-obsidian-cache.ts`

This is a hand-run smoke test, not part of `bun test`. It exercises the real network + `hdiutil` path. Used during development and final acceptance.

- [ ] **Step 1: Create the script**

Create `plugin/e2e/scripts/test-obsidian-cache.ts`:

```ts
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
  const lock = path.join(CACHE, ".download.lock");
  fs.mkdirSync(lock);
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  fs.writeFileSync(path.join(lock, "pid"), String(dead.pid));
  assert(isStaleLock(lock, 60_000), "isStaleLock detects dead pid");
  await ensureObsidian(); // should reclaim
  assert(!fs.existsSync(lock), "stale lock cleared after ensureObsidian");

  console.log("\nALL CHECKS PASSED");
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the self-test**

```bash
cd ~/void-os/plugin && bun run e2e/scripts/test-obsidian-cache.ts
```

Expected: prints `ALL CHECKS PASSED` after ~30–90s on first run (depends on network). Each subsequent run takes only ~30s (one extra re-download triggered by step 3).

If it fails: inspect stderr; the most common cold-run failure is network (404 / redirect / proxy). Fix and rerun.

- [ ] **Step 3: Commit**

```bash
cd ~/void-os
git add plugin/e2e/scripts/test-obsidian-cache.ts
git commit -m "test(VOS-94): manual integration self-test for obsidian-cache"
```

---

## Task 8: Wire `globalSetup.ts` to use the cached binary

**Files:**
- Modify: `plugin/e2e/globalSetup.ts:154`

- [ ] **Step 1: Add the import**

In `plugin/e2e/globalSetup.ts`, after the existing imports (currently lines 16–22), add:

```ts
import { ensureObsidian } from "./obsidian-cache.ts";
```

- [ ] **Step 2: Replace the hardcoded spawn target**

The current code (lines 152–164) reads:

```ts
  // Spawn Obsidian with CDP debugger + fixture vault.
  const obsidian: ChildProcess = spawn(
    "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${obsidianUserDataDir}`,
      VAULT_PATH,
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
    },
  );
```

Change it to:

```ts
  // Spawn Obsidian (from local cache) with CDP debugger + fixture vault.
  const obsidianBin = await ensureObsidian();
  const obsidian: ChildProcess = spawn(
    obsidianBin,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${obsidianUserDataDir}`,
      VAULT_PATH,
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
    },
  );
```

- [ ] **Step 3: Verify no other `/Applications/Obsidian` reference remains**

```bash
cd ~/void-os && grep -rn "/Applications/Obsidian" plugin/
```

Expected: zero matches (or only inside a documented comment that we'll update in Task 10).

- [ ] **Step 4: Commit**

```bash
cd ~/void-os
git add plugin/e2e/globalSetup.ts
git commit -m "feat(VOS-94): globalSetup uses cached Obsidian binary"
```

---

## Task 9: `.gitignore` + `playwright.config.ts` timeout bump

**Files:**
- Modify: `plugin/e2e/.gitignore`
- Modify: `plugin/e2e/playwright.config.ts`

- [ ] **Step 1: Add cache to `.gitignore`**

Append to `plugin/e2e/.gitignore`:

```

# VOS-94: e2e Obsidian binary cache (downloaded by globalSetup).
.cache/
```

- [ ] **Step 2: Bump Playwright globalTimeout**

Edit `plugin/e2e/playwright.config.ts`. Current:

```ts
export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  globalSetup: path.join(__dirname, "globalSetup.ts"),
  globalTeardown: path.join(__dirname, "globalTeardown.ts"),
  use: {
    headless: false,
  },
});
```

Change to:

```ts
export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // Cold cache: globalSetup may download ~140MB Obsidian DMG + extract (≤5 min on slow link).
  // Warm cache: globalSetup overhead is unchanged (~5s).
  globalTimeout: 5 * 60_000,
  reporter: [["list"]],
  globalSetup: path.join(__dirname, "globalSetup.ts"),
  globalTeardown: path.join(__dirname, "globalTeardown.ts"),
  use: {
    headless: false,
  },
});
```

- [ ] **Step 3: Verify the cache dir is now ignored**

```bash
cd ~/void-os && touch plugin/e2e/.cache/.probe && git status --short plugin/e2e/.cache
rm plugin/e2e/.cache/.probe 2>/dev/null
```

Expected: no output from `git status` for that path.

- [ ] **Step 4: Commit**

```bash
cd ~/void-os
git add plugin/e2e/.gitignore plugin/e2e/playwright.config.ts
git commit -m "chore(VOS-94): gitignore .cache/ + raise Playwright globalTimeout to 5min"
```

---

## Task 10: README update

**Files:**
- Modify: `plugin/e2e/README.md`

- [ ] **Step 1: Update prereqs**

Find the existing prereqs block:

```
- macOS (v1 is macOS-headed only)
- Obsidian installed at `/Applications/Obsidian.app` (VOS-94 will cache a local copy under `.cache/`)
- bun (this repo's package manager)
```

Replace with:

```
- macOS (v1 is macOS-headed only)
- bun (this repo's package manager)
- Internet access on first run (downloads pinned Obsidian binary into `plugin/e2e/.cache/`)
```

- [ ] **Step 2: Append the cache section**

Append at the end of `plugin/e2e/README.md`:

```markdown

## Obsidian binary cache

The harness owns its own Obsidian binary under `plugin/e2e/.cache/` (gitignored). `globalSetup.ts` calls `ensureObsidian()` from `plugin/e2e/obsidian-cache.ts`, which downloads the pinned `Obsidian-<VERSION>.dmg` on first run and reuses the extracted `.app` on every subsequent run. The host's `/Applications/Obsidian.app` is never touched.

- **Where:** `plugin/e2e/.cache/Obsidian.app/Contents/MacOS/Obsidian`
- **Version pin:** `OBSIDIAN_VERSION` const in `plugin/e2e/obsidian-cache.ts`
- **First run:** one-time download + extract (~30–90s depending on network).
- **Subsequent runs:** unchanged speed (~5s globalSetup overhead).
- **How to clear:** `rm -rf plugin/e2e/.cache`. Next `bun run e2e` re-downloads.
- **How to bump version:** edit `OBSIDIAN_VERSION` in `plugin/e2e/obsidian-cache.ts`. Next run wipes the cached bundle and re-downloads — no manual cleanup.
- **Concurrency:** two parallel runs serialize via `plugin/e2e/.cache/.download.lock`. SIGKILL or hard reboot during a download is auto-recovered on the next run via a pidfile + mtime stale-lock heuristic.
- **Platform:** macOS-only. Linux/CI support is a separate follow-up.
- **Manual smoke test of the cache itself:** `bun run e2e/scripts/test-obsidian-cache.ts` from the `plugin/` directory.
```

- [ ] **Step 3: Commit**

```bash
cd ~/void-os
git add plugin/e2e/README.md
git commit -m "docs(VOS-94): e2e README — Obsidian binary cache"
```

---

## Task 11: Full acceptance verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm `/Applications/Obsidian.app` is not in the spawn path**

```bash
cd ~/void-os && grep -rn "/Applications/Obsidian" plugin/
```

Expected: zero matches.

- [ ] **Step 2: Run the full unit suite**

```bash
cd ~/void-os/plugin && bun test test/obsidian-cache.test.ts
```

Expected: all tests pass (15+ across Tasks 1–5).

- [ ] **Step 3: Cold-run e2e from a clean cache**

```bash
cd ~/void-os && rm -rf plugin/e2e/.cache
cd ~/void-os/plugin && bun run e2e
```

Expected:
- globalSetup logs the cache download (visible because `stdio: "inherit"` is not set — if not visible, that's still fine).
- The full e2e spec from VOS-93 (chat round-trip) passes.
- After the run, `plugin/e2e/.cache/Obsidian.app/Contents/MacOS/Obsidian` exists.

- [ ] **Step 4: Warm-run e2e**

```bash
cd ~/void-os/plugin && bun run e2e
```

Expected: same green result; globalSetup overhead noticeably faster than step 3 (no download).

- [ ] **Step 5: Acceptance with `/Applications/Obsidian.app` quit**

Quit Obsidian on the host (Cmd-Q from the dock icon, or `osascript -e 'quit app "Obsidian"'`). Re-run `bun run e2e`. Expected: still green — the harness spawns the cached binary, not the host's.

For full assurance: temporarily move the host install aside:

```bash
sudo mv /Applications/Obsidian.app /Applications/Obsidian.app.bak
cd ~/void-os/plugin && bun run e2e
sudo mv /Applications/Obsidian.app.bak /Applications/Obsidian.app
```

Expected: e2e green even with the host install absent.

- [ ] **Step 6: Mark the task acceptance boxes**

Read `vault/work/tasks/active/VOS-94-e2e-local-obsidian-binary-cache.md` and tick each `## Acceptance` item that is now verified. Commit via `tools/state-write/sw` (handled by `/work` orchestrator after this plan completes — do not commit task-file state-plane edits from inside the void-os worktree).

- [ ] **Step 7: Final acceptance commit (no-op if step 6 already covered)**

If any verification-only artifacts changed (none expected), add and commit. Otherwise skip.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Plan task |
|---|---|
| Module surface (`OBSIDIAN_VERSION`, `ensureObsidian`) | Task 1, 6 |
| Platform guard | Task 1 |
| Cache layout (VERSION, `.app`, `.download.lock`, `.tmp-<pid>`) | Tasks 6 (extract), 4 (lock) |
| Algorithm (mkdirSync → cacheIsValid → acquireLock → re-check → downloadAndExtract → write VERSION → release) | Task 6 |
| Download + extract (fetch redirect, octet-stream guard, hdiutil attach, cp, unconditional rm, atomic rename, detach in finally, dmg cleanup) | Tasks 5, 6 |
| Lock with pidfile + stale heuristic | Tasks 3, 4 |
| `.gitignore` `.cache/` | Task 9 |
| README cache section | Task 10 |
| Playwright globalTimeout bound | Task 9 |
| Error handling (platform, fetch, hdiutil attach/detach, lock timeout, partial extract) | Tasks 1, 5, 6, 4 |
| Testing layer 1 (unit) | Tasks 1–5 |
| Testing layer 2 (integration) | Task 7 |
| Acceptance mapping (gitignore, first-run download, pinned version, timeout, /Applications quit, executablePath, README) | Task 11 |

No gaps.

**2. Placeholder scan:** None — every step has concrete code or a concrete command with expected output.

**3. Type consistency:**
- `cacheIsValid(versionFile, binPath, expected)` — three args in both signature and call site (Task 6 wiring). ✓
- `acquireLock(lockDir, timeoutMs)`, `isStaleLock(lockDir, timeoutMs)`, `buildDmgUrl(version)`, `assertDmgResponse(res, url)`, `downloadAndExtract(cacheDir, appPath, version)` — all signatures match call sites. ✓
- `ensureObsidian(): Promise<string>` — matches spec + the `await ensureObsidian()` in globalSetup. ✓
