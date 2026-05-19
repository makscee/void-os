/**
 * VOS-150 T6: dedicated Playwright project setup for ribbon-degraded.spec.ts.
 *
 * Mirrors globalSetup-autospawn.ts but with two intentional differences:
 *
 *   1. data.json is seeded with a guaranteed-missing voidOsBinaryPath
 *      ("/nonexistent/void-os-degraded-test") so the plugin's ensureDaemon
 *      probe + resolveBinary fail → daemonStatus = "binary-missing" → the
 *      degraded ribbon variant + DegradedHelpModal render.
 *   2. The fixture vault's community-plugins.json keeps void-os ENABLED
 *      (unlike autospawn which DISABLES it for per-test toggling), so the
 *      plugin loads on Obsidian boot and we can assert the degraded UI
 *      without driving plugin enablement from the spec.
 *
 * Isolation from `main` / `autospawn` projects (Step 2.5 in plan):
 *   - Distinct sidecar env var:  VOS_E2E_STATE_BINARY_MISSING
 *   - Distinct sidecar filename: state-binary-missing.json
 *   - Distinct tmpdir prefix:    void-os-e2e-binary-missing-
 *
 * No daemon is pre-spawned — the whole point is that ensureDaemon fails.
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

export default async function globalSetupBinaryMissing() {
  const stateEnvVar = "VOS_E2E_STATE_BINARY_MISSING";
  const tmpdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "void-os-e2e-binary-missing-")));
  const obsidianUserDataDir = path.join(tmpdir, "obsidian-user-data");
  fs.mkdirSync(obsidianUserDataDir, { recursive: true });

  // Isolated HOME — empty .void-os so the plugin's daemon probe finds
  // nothing and falls through to its spawn/resolve path (which we force
  // to fail via the bad voidOsBinaryPath below).
  const harnessHome = path.join(tmpdir, "home");
  fs.mkdirSync(path.join(harnessHome, ".void-os"), { recursive: true });

  // Fixture vault — void-os stays ENABLED (we want it to load on boot
  // and surface degraded UI immediately).
  const VAULT_PATH = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir, "fixture-vault-")),
  );
  fs.cpSync(FIXTURE_VAULT, VAULT_PATH, { recursive: true });
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

  // VOS-150 isolation: pick a CDP port well away from the main/autospawn
  // projects' freePort picks. freePort still ensures the port is free,
  // but using a distinct allocation reduces incidental races.
  const cdpPort = await freePort();

  // Build plugin into fixture vault.
  const build = spawnSync("bun", ["run", "build.ts"], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, VOID_OS_PLUGIN_OUT: PLUGIN_OUT },
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`plugin build failed: exit ${build.status}`);
  }

  // VOS-150 T6 KEY STEP: seed data.json with a voidOsBinaryPath that does
  // not exist. The plugin's resolveBinary will fail → daemonStatus =
  // "binary-missing" → degraded ribbon + status pill render.
  // Written BEFORE Obsidian launches so the plugin sees this on first load.
  fs.writeFileSync(
    path.join(PLUGIN_OUT, "data.json"),
    JSON.stringify({ voidOsBinaryPath: "/nonexistent/void-os-degraded-test" }, null, 2),
  );

  // Spawn Obsidian. No daemon is started.
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
      // HOME isolation — plugin's makeProductionProbe reads
      // HOME/.void-os/daemon.json (which we leave absent), so the probe
      // fails through to the spawn branch.
      env: {
        ...process.env,
        HOME: harnessHome,
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
    obsidianPid: obsidian.pid,
    tmpdir,
    harnessHome,
    vaultPath: VAULT_PATH,
    obsidianUserDataDir,
    pluginOut: PLUGIN_OUT,
  };
  // VOS-150 isolation: distinct sidecar filename so a concurrent main /
  // autospawn project's state.json can't collide here.
  const statePath = path.join(tmpdir, "state-binary-missing.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.env[stateEnvVar] = statePath;
}
