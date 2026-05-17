import { test, expect, chromium, type Page, type Browser } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";

/**
 * VOS-120 T9: daemon lifecycle E2E.
 *
 * Runs under the `autospawn` Playwright project. Its globalSetup launches
 * Obsidian with the void-os plugin DISABLED in community-plugins.json and
 * an EMPTY isolated ~/.void-os under harnessHome. Each test:
 *
 *   1. Sets up the initial state it wants to assert against (rewrites
 *      data.json, optionally pre-spawns a daemon via the packaged binary).
 *   2. Enables the plugin via `app.plugins.enablePlugin("void-os")`.
 *   3. Waits for the plugin's onload to settle, reads `daemonStatus`,
 *      asserts.
 *   4. Cleans up: disables the plugin, kills any daemon under harnessHome,
 *      removes daemon.json + token so the next test starts clean.
 *
 * The 6 cases collectively exercise every branch in
 * plugin/src/main.ts#onload + the ensureDaemon contract:
 *
 *   - attached: pre-spawned daemon → probe attaches → no second spawn
 *   - idempotent: same as attached + assert pid unchanged on a follow-up
 *     plugin reload
 *   - cold-start: empty state → plugin spawns daemon via its CLI
 *   - vault-mismatch: pre-spawn daemon for synthetic vault A → enable plugin
 *     against the real vault → VaultMismatchError surfaces
 *   - crash+respawn: cold-start → SIGKILL daemon → FSM auto-respawn one shot
 *   - binary-missing: data.json voidOsBinaryPath=/nonexistent → plugin
 *     reports binary-missing state
 */

interface E2EState {
  cdpPort: number;
  daemonPort: number;
  obsidianPid: number;
  tmpdir: string;
  harnessHome: string;
  vaultPath: string;
  pluginOut: string;
  binPath: string;
}

function readState(): E2EState {
  const statePath = process.env.VOS_E2E_STATE_AUTOSPAWN;
  if (!statePath) throw new Error("VOS_E2E_STATE_AUTOSPAWN not set — autospawn globalSetup did not run");
  return JSON.parse(readFileSync(statePath, "utf8")) as E2EState;
}

async function getVaultPage(cdpPort: number): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  let page = browser.contexts().flatMap((ctx) => ctx.pages())
    .find((p) => p.url() === "app://obsidian.md/index.html");
  if (!page) {
    const ctx = browser.contexts()[0];
    page = await ctx.waitForEvent("page", {
      predicate: (p) => p.url() === "app://obsidian.md/index.html",
      timeout: 20_000,
    });
  }
  await page.waitForLoadState("domcontentloaded");
  // First-boot Trust author modal — best-effort dismiss.
  const trustBtn = page.getByRole("button", { name: /Trust author/i });
  try { await trustBtn.click({ timeout: 5_000 }); } catch { /* already trusted */ }
  return { browser, page };
}

type DaemonStatus =
  | { state: "running"; port: number; vault: string; version: string }
  | { state: "binary-missing" }
  | { state: "vault-mismatch"; activeVault: string }
  | { state: "spawn-failed"; error: string }
  | { state: "daemon-died" };

/** Read the plugin's published daemonStatus via the renderer. Returns null
 *  if the plugin is currently disabled (app.plugins.plugins[id] is absent). */
async function readDaemonStatus(page: Page): Promise<DaemonStatus | null> {
  return page.evaluate(() => {
    const app = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app;
    const plugin = app.plugins.plugins["void-os"] as { daemonStatus: unknown } | undefined;
    if (!plugin) return null;
    return plugin.daemonStatus as DaemonStatus;
  });
}

/** Enable the plugin and wait for onload's ensureDaemon to settle by polling
 *  daemonStatus until it leaves the not-initialized sentinel. */
async function enablePluginAndWait(page: Page, timeoutMs = 15_000): Promise<DaemonStatus> {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { plugins: { enablePlugin: (id: string) => Promise<void> } } }).app;
    await app.plugins.enablePlugin("void-os");
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await readDaemonStatus(page);
    if (s && !(s.state === "spawn-failed" && s.error === "not-initialized")) {
      return s;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`daemonStatus did not settle within ${timeoutMs}ms`);
}

async function disablePlugin(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { plugins: { disablePlugin: (id: string) => Promise<void> } } }).app;
      await app.plugins.disablePlugin("void-os");
    });
  } catch { /* page may already be closed */ }
}

interface DaemonJson { pid: number; port: number; vault_root: string; version: string; started_at: string; }

function readDaemonJson(harnessHome: string): DaemonJson | null {
  const p = path.join(harnessHome, ".void-os", "daemon.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as DaemonJson; } catch { return null; }
}

function clearDaemonState(harnessHome: string): void {
  for (const f of ["daemon.json", "daemon.pid", "daemon.port", "token", "daemon.log"]) {
    const p = path.join(harnessHome, ".void-os", f);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
}

function killByPid(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, intervalMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = probe();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

/** Pre-spawn a daemon via the packaged CLI under the isolated HOME. Used by
 *  the attached / idempotent / vault-mismatch cases. */
function preSpawnDaemon(state: E2EState, vaultRoot: string): { pid: number; port: number } {
  // Use `void-os daemon start --vault <path>` so the CLI handles
  // token/pidfile writes. VOID_OS_PORT pins the daemon to the harness's
  // pre-allocated free port (CLI default 7777 collides with real-user
  // daemons on the dev box).
  const child = spawn(state.binPath, ["daemon", "start", "--vault", vaultRoot], {
    env: {
      ...process.env,
      HOME: state.harnessHome,
      VOID_OS_PORT: String(state.daemonPort),
    } as NodeJS.ProcessEnv,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  // Block until the pidfile lands.
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const rec = readDaemonJson(state.harnessHome);
    if (rec) return { pid: rec.pid, port: rec.port };
    spawnSync("sleep", ["0.2"]);
  }
  throw new Error("preSpawnDaemon: daemon.json never appeared");
}

/** Write data.json with the given fields, preserving anything we don't touch. */
function writeDataJson(pluginOut: string, fields: Record<string, unknown>): void {
  const p = path.join(pluginOut, "data.json");
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { /* fresh */ }
  writeFileSync(p, JSON.stringify({ ...cur, ...fields }, null, 2));
}

test.describe("daemon-autospawn lifecycle", () => {
  test.beforeEach(async () => {
    const state = readState();
    // Reset to a clean baseline: no daemon, good binary path in data.json.
    const existing = readDaemonJson(state.harnessHome);
    if (existing) killByPid(existing.pid);
    // Give the OS a moment to release the port before next test spawns.
    await new Promise((r) => setTimeout(r, 300));
    clearDaemonState(state.harnessHome);
    writeDataJson(state.pluginOut, { voidOsBinaryPath: state.binPath });
  });

  test.afterEach(async () => {
    const state = readState();
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      await disablePlugin(page);
    } finally {
      await browser.close();
    }
    const rec = readDaemonJson(state.harnessHome);
    if (rec) {
      killByPid(rec.pid);
      // Wait for process to die so port frees before next test.
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try { process.kill(rec.pid, 0); } catch { break; }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    clearDaemonState(state.harnessHome);
  });

  test("attached: pre-spawned daemon → plugin attaches without second spawn", async () => {
    const state = readState();
    const preSpawned = preSpawnDaemon(state, state.vaultPath);
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      const status = await enablePluginAndWait(page);
      expect(status.state).toBe("running");
      if (status.state !== "running") throw new Error("status not running"); // narrow
      expect(status.port).toBe(preSpawned.port);
      expect(status.vault).toContain("fixture-vault");
      // daemon.json pid still equals pre-spawned (no respawn).
      const rec = readDaemonJson(state.harnessHome);
      expect(rec?.pid).toBe(preSpawned.pid);
    } finally {
      await browser.close();
    }
  });

  test("idempotent: plugin disable+enable reuses the same daemon pid", async () => {
    const state = readState();
    const preSpawned = preSpawnDaemon(state, state.vaultPath);
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      await enablePluginAndWait(page);
      const pidBefore = readDaemonJson(state.harnessHome)?.pid;
      expect(pidBefore).toBe(preSpawned.pid);

      // Disable + re-enable. The plugin's onload should probe + attach
      // again to the same daemon, NOT spawn a new one.
      await disablePlugin(page);
      await page.waitForTimeout(500);
      const status = await enablePluginAndWait(page);
      expect(status.state).toBe("running");
      const pidAfter = readDaemonJson(state.harnessHome)?.pid;
      expect(pidAfter).toBe(pidBefore);
    } finally {
      await browser.close();
    }
  });

  test("cold-start: empty state → plugin spawns a fresh daemon", async () => {
    const state = readState();
    // beforeEach already cleared state. Confirm.
    expect(readDaemonJson(state.harnessHome)).toBeNull();
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      const status = await enablePluginAndWait(page, 20_000);
      expect(status.state).toBe("running");
      if (status.state !== "running") throw new Error("status not running");
      expect(status.port).toBeGreaterThan(0);
      expect(status.vault).toContain("fixture-vault");
      const rec = readDaemonJson(state.harnessHome);
      expect(rec).not.toBeNull();
      expect(rec?.port).toBe(status.port);
    } finally {
      await browser.close();
    }
  });

  test("vault-mismatch: daemon serves another vault → plugin reports vault-mismatch", async () => {
    const state = readState();
    // Pre-spawn a daemon pointed at a synthetic vault path (not the real
    // Obsidian vault). The CLI's vault-aware check uses the path verbatim
    // — it doesn't need to actually exist on disk for the daemon's
    // /health to report it back.
    const syntheticVault = path.join(state.tmpdir, "synthetic-other-vault");
    // Make it exist so the daemon's vault scanner can read it cleanly.
    spawnSync("mkdir", ["-p", path.join(syntheticVault, "agents")]);
    const preSpawned = preSpawnDaemon(state, syntheticVault);
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      const status = await enablePluginAndWait(page);
      expect(status.state).toBe("vault-mismatch");
      if (status.state !== "vault-mismatch") throw new Error("status not vault-mismatch");
      expect(status.activeVault).toContain("synthetic-other-vault");
      // No second daemon spawned — pid unchanged.
      const rec = readDaemonJson(state.harnessHome);
      expect(rec?.pid).toBe(preSpawned.pid);
    } finally {
      await browser.close();
    }
  });

  test("crash+respawn: SIGKILL the daemon → FSM auto-respawn one shot", async () => {
    const state = readState();
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      const initial = await enablePluginAndWait(page, 20_000);
      expect(initial.state).toBe("running");
      if (initial.state !== "running") throw new Error("status not running");
      const pid1 = readDaemonJson(state.harnessHome)?.pid;
      expect(pid1).toBeDefined();

      // Kill the daemon hard. The FSM's WS layer will see the connection
      // drop, probeHealth will confirm dead, restartDaemon spends the
      // one-shot auto-respawn budget.
      process.kill(pid1!, "SIGKILL");

      // Wait for the pidfile to be rewritten with a different pid.
      const rec2 = await waitFor(
        () => {
          const r = readDaemonJson(state.harnessHome);
          if (!r) return null;
          if (r.pid === pid1) return null;
          return r;
        },
        20_000,
      );
      expect(rec2.pid).not.toBe(pid1);
      expect(rec2.pid).toBeGreaterThan(0);
      // Plugin's daemonStatus eventually catches up to running again.
      const final = await waitFor(
        async () => {
          const s = await readDaemonStatus(page);
          if (s && s.state === "running" && s.port === rec2.port) return s;
          return null;
        },
        15_000,
      );
      expect(final.state).toBe("running");
    } finally {
      await browser.close();
    }
  });

  test("binary-missing: bad voidOsBinaryPath → daemonStatus = binary-missing", async () => {
    const state = readState();
    // Overwrite data.json entirely so any cached resolvedBinaryPath from a
    // prior test in the same project run is wiped — resolveBinary checks
    // BOTH voidOsBinaryPath and resolvedBinaryPath, and the cache would
    // happily resolve to the good binary even with a bad override.
    writeFileSync(
      path.join(state.pluginOut, "data.json"),
      JSON.stringify({ voidOsBinaryPath: "/nonexistent/void-os" }, null, 2),
    );
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      const status = await enablePluginAndWait(page, 20_000);
      expect(status.state).toBe("binary-missing");
    } finally {
      await browser.close();
    }
  });
});
