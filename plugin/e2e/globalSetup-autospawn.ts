/**
 * VOS-120 T9: dedicated Playwright project setup for daemon-autospawn.spec.ts.
 *
 * Unlike the main project (which pre-spawns a daemon and writes daemon.json
 * before launching Obsidian), this setup leaves ~/.void-os EMPTY so each test
 * can drive its own initial state via the plugin's onload codepath:
 *
 *   - cold-start: enable plugin → ensureDaemon's probe fails → spawn branch
 *     runs against the seeded voidOsBinaryPath
 *   - attached: pre-spawn a daemon via `child_process.spawn(bin, ["daemon",
 *     "start", "--vault", VAULT_PATH])` BEFORE enabling the plugin → probe
 *     hits, plugin attaches without spawning
 *   - vault-mismatch: pre-spawn daemon for a synthetic vault path → enable
 *     plugin against the real vault → VaultMismatchError surfaces as Notice +
 *     daemonStatus = vault-mismatch
 *   - binary-missing: rewrite data.json voidOsBinaryPath to /nonexistent →
 *     enable plugin → ensureDaemon probe fails, resolveBinary throws →
 *     daemonStatus = binary-missing
 *   - crash+respawn: cold-start, capture pid, SIGKILL, wait for FSM auto-
 *     respawn (probeHealth detects daemon-died, calls restartDaemon)
 *
 * Obsidian boots once with community-plugins.json = [] so void-os is loaded
 * but DISABLED. Each test enables the plugin via
 * `app.plugins.enablePlugin("void-os")`, asserts, then disables it +
 * tears down the daemon as cleanup. The sidecar state.json exposes
 * harnessHome / vaultPath / cdpPort / binPath so specs can reach them.
 */
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureObsidian } from "./obsidian-cache.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const FIXTURE_VAULT = path.join(HERE, "fixtures", "vault");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("freePort: address() returned non-object"));
      }
    });
  });
}

async function waitForCdp(cdpPort: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${cdpPort}/json/version`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Obsidian CDP did not become ready on :${cdpPort} within ${timeoutMs}ms`);
}

export default async function globalSetupAutospawn() {
  const stateEnvVar = "VOS_E2E_STATE_AUTOSPAWN";
  const tmpdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "void-os-e2e-autospawn-")));
  const obsidianUserDataDir = path.join(tmpdir, "obsidian-user-data");
  fs.mkdirSync(obsidianUserDataDir, { recursive: true });

  // Isolated HOME — empty .void-os so per-test state setup is the only thing
  // the plugin observes on probe.
  const harnessHome = path.join(tmpdir, "home");
  fs.mkdirSync(path.join(harnessHome, ".void-os"), { recursive: true });

  // Fixture vault with void-os DISABLED initially (community-plugins.json
  // overwritten to []). Tests enable per-case.
  const VAULT_PATH = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir, "fixture-vault-")),
  );
  fs.cpSync(FIXTURE_VAULT, VAULT_PATH, { recursive: true });
  fs.writeFileSync(
    path.join(VAULT_PATH, ".obsidian", "community-plugins.json"),
    "[]",
  );
  const PLUGIN_OUT = path.join(VAULT_PATH, ".obsidian", "plugins", "void-os");

  // Pre-register the vault in obsidian.json so Obsidian opens it directly.
  const vaultId = crypto.createHash("md5").update(VAULT_PATH).digest("hex").slice(0, 16);
  fs.writeFileSync(
    path.join(obsidianUserDataDir, "obsidian.json"),
    JSON.stringify({
      vaults: {
        [vaultId]: { path: VAULT_PATH, ts: Date.now(), open: true, trusted: true },
      },
      updateDisabled: true,
    }, null, 2),
  );

  const cdpPort = await freePort();
  // Pre-pick a free port for the daemon spawned by the plugin (or by tests
  // doing pre-spawn). The CLI defaults to 7777 which collides with any
  // real-user daemon on the developer's box.
  const daemonPort = await freePort();

  // Build plugin into fixture vault.
  const build = spawnSync("bun", ["run", "build.ts"], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, VOID_OS_PLUGIN_OUT: PLUGIN_OUT },
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`plugin build failed: exit ${build.status}`);
  }

  // Seed a baseline data.json with the GOOD voidOsBinaryPath so the cold-start
  // case can spawn. Each test rewrites this if it needs a different shape
  // (e.g. binary-missing).
  const binPath = path.resolve(PLUGIN_ROOT, "..", "bin", "void-os");
  fs.writeFileSync(
    path.join(PLUGIN_OUT, "data.json"),
    JSON.stringify({ voidOsBinaryPath: binPath }, null, 2),
  );

  // Spawn Obsidian (plugin is DISABLED — tests enable per-case).
  let obsidianBin: string;
  try {
    obsidianBin = await ensureObsidian();
  } catch (err) {
    throw err;
  }
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
      // HOME isolation: when the plugin spawns its daemon, the daemon
      // inherits Obsidian's env, so its ~/.void-os writes land in our tmpdir.
      // VOID_OS_PORT propagates down through Obsidian → plugin spawn →
      // daemon so we don't collide with a real-user daemon on :7777.
      env: {
        ...process.env,
        HOME: harnessHome,
        VOID_OS_PORT: String(daemonPort),
      } as NodeJS.ProcessEnv,
    },
  );

  try {
    await waitForCdp(cdpPort, 20_000);
  } catch (err) {
    obsidian.kill("SIGKILL");
    throw err;
  }

  const state = {
    cdpPort,
    daemonPort,
    obsidianPid: obsidian.pid,
    tmpdir,
    harnessHome,
    vaultPath: VAULT_PATH,
    obsidianUserDataDir,
    pluginOut: PLUGIN_OUT,
    binPath,
  };
  const statePath = path.join(tmpdir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.env[stateEnvVar] = statePath;
}
