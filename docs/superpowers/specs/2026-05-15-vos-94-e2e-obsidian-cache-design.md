---
task: VOS-94
title: e2e harness — local Obsidian binary cache
created: 2026-05-15
status: draft
---

# VOS-94 — e2e Obsidian binary cache

## Goal

The Playwright e2e harness (VOS-93) currently spawns `/Applications/Obsidian.app/Contents/MacOS/Obsidian`. This couples the harness to the developer's installed Obsidian and blocks any future CI machine that doesn't have it. Replace it with a self-managed cache under `plugin/e2e/.cache/` that downloads a pinned Obsidian release on first run and reuses it forever after.

## Non-goals

- Linux / AppImage support. Stays a follow-up. This spec is **macOS-only**; the module exposes a platform check that throws a clear error elsewhere.
- Checksum verification. We trust the pinned GitHub release URL.
- Per-Node-version isolation. Cache is shared across the repo.
- Auto-updating Obsidian. Version bumps are a deliberate code change.

## Architecture

### New module: `plugin/e2e/obsidian-cache.ts`

```ts
export const OBSIDIAN_VERSION = "1.8.10";

// Resolves a path to a usable Obsidian executable in the local cache.
// Downloads + extracts on first call (or after a version bump). Idempotent,
// concurrency-safe. Returns the absolute path to the Obsidian binary.
export async function ensureObsidian(): Promise<string>;
```

`ensureObsidian()` is the only exported symbol used by callers. The constant is exported so the README and tests can reference it without importing the platform helpers.

### Caller: `plugin/e2e/globalSetup.ts`

Two changes:

1. Add `import { ensureObsidian } from "./obsidian-cache.ts";` at the top.
2. Replace the spawn target at line 154:

```ts
const obsidianBin = await ensureObsidian();
const obsidian: ChildProcess = spawn(obsidianBin, [ ... ]);
```

Nothing else in globalSetup changes.

## Cache layout

```
plugin/e2e/.cache/
├── VERSION                        # one-line file: "1.8.10\n"
├── Obsidian.app/                  # extracted .app bundle
│   └── Contents/MacOS/Obsidian    # the binary
├── .download.lock/                # directory used as lock (mkdir = atomic)
└── .tmp-<pid>/                    # transient during extract
```

- **`Obsidian.app/`** — the final extracted bundle. Path is stable so the executable path never moves between runs.
- **`VERSION`** — written *after* a successful extract. Presence + matching content is the "cache is good" marker. Missing or mismatched → re-download.
- **`.download.lock/`** — short-lived directory; `mkdir` is atomic on POSIX. Concurrent runs use this to serialize first-time work.
- **`.tmp-<pid>/`** — extract destination before atomic rename into place.

## Algorithm

```ts
async function ensureObsidian() {
  if (process.platform !== "darwin") throw new Error("VOS-94: macOS only; Linux follow-up pending");

  const cacheDir = path.join(HERE, ".cache");
  const appPath = path.join(cacheDir, "Obsidian.app");
  const binPath = path.join(appPath, "Contents", "MacOS", "Obsidian");
  const versionFile = path.join(cacheDir, "VERSION");
  const lockDir = path.join(cacheDir, ".download.lock");

  fs.mkdirSync(cacheDir, { recursive: true });

  if (cacheIsValid(versionFile, binPath)) return binPath;

  await acquireLock(lockDir, /* timeoutMs */ 5 * 60_000);
  try {
    // Re-check inside the lock — another runner may have just finished.
    if (cacheIsValid(versionFile, binPath)) return binPath;

    await downloadAndExtract(cacheDir, appPath, OBSIDIAN_VERSION);
    fs.writeFileSync(versionFile, `${OBSIDIAN_VERSION}\n`);
    return binPath;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function cacheIsValid(versionFile, binPath) {
  if (!fs.existsSync(versionFile) || !fs.existsSync(binPath)) return false;
  return fs.readFileSync(versionFile, "utf8").trim() === OBSIDIAN_VERSION;
}
```

### Download + extract (`downloadAndExtract`)

1. Build URL: `https://github.com/obsidianmd/obsidian-releases/releases/download/v${VERSION}/Obsidian-${VERSION}.dmg`.
2. Download to `<cacheDir>/Obsidian-${VERSION}.dmg` using `fetch(url, { redirect: "follow" })` + stream `response.body` to disk. **Before streaming:** assert `response.ok` and `response.headers.get("content-type")?.includes("octet-stream")` — GitHub returns 302 to `release-assets.githubusercontent.com`; if redirect drops auth or hits an HTML error page, a misrouted response will silently write garbage and `hdiutil` will fail with a confusing "not recognized" error. On either assertion failure, throw with `status`, final URL, and content-type.
3. Mount via `hdiutil attach -nobrowse -quiet <dmg>` — parse stdout for the mount point (`/Volumes/Obsidian X.Y.Z`).
4. `fs.cpSync(<mount>/Obsidian.app, <cacheDir>/.tmp-<pid>/Obsidian.app, { recursive: true })`.
5. `hdiutil detach -quiet <mount>` (always, even on failure — wrap step 4 in try/finally).
6. **Unconditionally** `fs.rmSync(appPath, { recursive: true, force: true })` immediately before the rename. `rename(2)` onto an existing non-empty directory fails with `ENOTEMPTY` on macOS; the cache-valid re-check inside the lock already short-circuited the happy path, so anything still at `appPath` here is stale or partial and must go.
7. `fs.renameSync(<cacheDir>/.tmp-<pid>/Obsidian.app, appPath)` — atomic on same filesystem.
8. `fs.rmSync(<cacheDir>/.tmp-<pid>, { recursive: true, force: true })`.
9. `fs.rmSync(<cacheDir>/Obsidian-${VERSION}.dmg, { force: true })` — keep cache tight.

### Lock (`acquireLock`)

```ts
async function acquireLock(lockDir, timeoutMs) {
  const start = Date.now();
  let staleRetried = false;
  while (Date.now() - start < timeoutMs) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Stale-lock detection: dead owner OR ancient lock → reclaim once.
      if (!staleRetried && isStaleLock(lockDir, timeoutMs)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        staleRetried = true;
        continue;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`obsidian-cache: lock timeout after ${timeoutMs}ms (stale ${lockDir}?). Delete plugin/e2e/.cache/.download.lock if no other run is active.`);
}

function isStaleLock(lockDir, timeoutMs) {
  // (a) lock older than the full timeout window → definitely abandoned.
  const stat = fs.statSync(lockDir, { throwIfNoEntry: false });
  if (!stat) return false;
  if (Date.now() - stat.mtimeMs > timeoutMs) return true;
  // (b) pidfile present and owner process dead.
  const pidPath = path.join(lockDir, "pid");
  if (!fs.existsSync(pidPath)) return false;
  const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  if (!pid) return false;
  try { process.kill(pid, 0); return false; }     // alive
  catch { return true; }                           // ESRCH → dead
}
```

Long timeout (5 min) covers a cold download on a slow connection. Crash recovery is automatic: SIGKILL or hard reboot during a download leaves a lock dir, but the next run detects the dead pid (or the ancient mtime after `timeoutMs`) and reclaims it once before falling back to manual `rm -rf plugin/e2e/.cache` (documented in the README).

## .gitignore

Add to `plugin/e2e/.gitignore`:

```
# VOS-94: e2e Obsidian binary cache (downloaded by globalSetup).
.cache/
```

## README

Append a `### Obsidian binary cache` section to `plugin/e2e/README.md`:

- **Where:** `plugin/e2e/.cache/Obsidian.app` (gitignored).
- **What:** Self-managed Obsidian binary, version pinned in `obsidian-cache.ts` (`OBSIDIAN_VERSION`).
- **First run:** ~1 minute one-time download + extract. Subsequent runs reuse the cache.
- **How to clear:** `rm -rf plugin/e2e/.cache`. Next `bun test` re-downloads.
- **How to bump:** edit `OBSIDIAN_VERSION` in `plugin/e2e/obsidian-cache.ts`. Next run replaces the cached app automatically (single-dir strategy: version mismatch wipes the old bundle before extracting the new one).
- **Concurrency:** safe. Two parallel runs serialize via `plugin/e2e/.cache/.download.lock`.
- **Platform:** macOS-only. Linux/CI support pending follow-up task.

## Error handling

- **`process.platform !== "darwin"`** → throw with message naming the follow-up.
- **`fetch` non-2xx** → throw `obsidian-cache: download failed: HTTP <status> for <url>`. No retry (single-shot; user re-runs).
- **`hdiutil attach` non-zero** → throw with the captured stderr.
- **`hdiutil detach` failure** → log a warning but don't fail the test run; the mount will be GC'd at reboot.
- **Lock timeout** → throw with the suggestion to delete `.cache/`.
- **Disk full / partial extract** → the `.tmp-<pid>/` directory is untouched on failure; the next run re-extracts. The atomic rename means `Obsidian.app/` is never observed half-written.

## Testing

Two layers:

1. **Unit-ish self-test** — a separate `plugin/e2e/scripts/test-obsidian-cache.ts` script (not a Playwright test). Invokable manually:
   ```
   cd plugin && bun run e2e/scripts/test-obsidian-cache.ts
   ```
   Asserts: cold run downloads; second run is a no-op; corrupted `VERSION` triggers re-download; stale lock with dead pid is reclaimed within one poll interval. (Parallel-extract observation dropped — single-process no-op already proves the cache-hit path; the lock is best validated by code review + the stale-lock test.)

2. **Integration** — full `bun test --bail` from `plugin/`. Pre-conditions:
   - `/Applications/Obsidian.app` quit (and ideally moved aside or uninstalled for the final acceptance check).
   - `plugin/e2e/.cache/` empty (first run).
   Pass criteria: spec from VOS-93 (chat round-trip) passes; cached binary populated; second run faster (skip download).

## Acceptance mapping

Maps 1:1 to the task file:

| Task acceptance | How spec satisfies |
|---|---|
| `.cache/` in `.gitignore` | "`.gitignore`" section above |
| First-run download + extract | `ensureObsidian()` algorithm |
| Pinned version (no "latest") | `OBSIDIAN_VERSION` const |
| First run completes within Playwright `globalSetup` timeout (raised to 5 min for cold downloads) | `playwright.config.ts` sets `globalTimeout` accordingly; first run finishes inside it. Hard wall-clock budgets removed — they're reviewer-dependent and flaky on slow networks/external SSDs. |
| e2e green with `/Applications/Obsidian.app` quit | Spawn target sourced from cache, never `/Applications/` |
| `executablePath` references cached binary | `obsidianBin = await ensureObsidian()` |
| README documents cache | "README" section above |

## Out of scope / follow-ups

- **Linux / AppImage** — separate task. Suggested approach: branch on `process.platform`; AppImage path keeps the same module surface (`ensureObsidian()` returns the binary path).
- **CI integration** — once Linux is supported, add a `.cache/` cache key to CI to skip the download on every run.
- **Mass cleanup helper** — `plugin/e2e/scripts/clear-cache.sh` if `rm -rf` proves too coarse later.
