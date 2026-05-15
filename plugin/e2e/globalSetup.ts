/**
 * Playwright globalSetup for void-os e2e.
 *
 * Sequence:
 *   1. Pick a free port (daemon) + a free port (Obsidian CDP debugger).
 *   2. Build the plugin into the fixture vault.
 *   3. Write resolved settings (daemonUrl) into the fixture plugin dir.
 *   4. Spawn the daemon with isolated env (fake provider, stub titler, tmp DB,
 *      tmp vault root).
 *   5. Poll daemon for readiness.
 *   6. Spawn Obsidian with --remote-debugging-port=<cdpPort>.
 *   7. Poll CDP /json/version until ready.
 *   8. Persist state (daemon port, cdp port, pids, paths) to a sidecar JSON
 *      file so the spec + teardown can read it.
 */
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const DAEMON_ROOT = path.resolve(HERE, "..", "..", "daemon");
const FIXTURE_VAULT = path.join(HERE, "fixtures", "vault");
const DAEMON_FIXTURE_VAULT = path.join(HERE, "fixtures", "daemon-vault");
const FAKE_SCRIPT = path.join(HERE, "fixtures", "cc", "hello.jsonl");

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

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch { /* connection refused — keep trying */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not become ready on :${port} within ${timeoutMs}ms`);
}

async function waitForCdp(cdpPort: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${cdpPort}/json/version`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Obsidian CDP did not become ready on :${cdpPort} within ${timeoutMs}ms`);
}

export default async function globalSetup() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "void-os-e2e-"));
  const daemonVault = path.join(tmpdir, "vault");
  const dbPath = path.join(tmpdir, "state.sqlite");
  const obsidianUserDataDir = path.join(tmpdir, "obsidian-user-data");
  fs.mkdirSync(daemonVault, { recursive: true });
  fs.mkdirSync(obsidianUserDataDir, { recursive: true });

  // Plant a minimal `agents/maya/agent.md` into the daemon's vault so
  // boot-time `scanVaultAgents(...).upsertAll(...)` mirrors a real maya row
  // into the `agents` table. The agent picker (Obsidian SuggestModal) opens
  // on click of `new-chat-btn`; if the table is empty the picker shows the
  // empty notice and Enter is a no-op, blocking every spec that mints a chat.
  // The 0008 migration also seeds `maya`, but this fixture removes any
  // dependence on migration ordering or test-time DB state.
  fs.cpSync(DAEMON_FIXTURE_VAULT, daemonVault, { recursive: true });

  // Per-spec switchable fake script. Daemon points at this path for the
  // whole run; specs swap its contents by copying a different fixture in
  // before they kick a chat. Initialized with hello.jsonl so specs that
  // don't swap (e.g. chat-roundtrip) keep their original behaviour.
  const fakeScriptDir = path.join(tmpdir, "fake-script");
  fs.mkdirSync(fakeScriptDir, { recursive: true });
  const fakeScriptPath = path.join(fakeScriptDir, "active.jsonl");
  fs.copyFileSync(FAKE_SCRIPT, fakeScriptPath);

  // Copy the committed fixture vault into tmpdir so Obsidian's runtime writes
  // (workspace.json, appearance.json, plugin-data tweaks) don't pollute the
  // checked-in fixture. The build output + resolved data.json go into the
  // copy as well.
  const VAULT_PATH = path.join(tmpdir, "fixture-vault");
  fs.cpSync(FIXTURE_VAULT, VAULT_PATH, { recursive: true });
  const PLUGIN_OUT = path.join(VAULT_PATH, ".obsidian", "plugins", "void-os");

  // Pre-register the fixture vault in obsidian.json so Obsidian skips the
  // onboarding/starter screen and opens the vault directly.
  const vaultId = crypto.createHash("md5").update(VAULT_PATH).digest("hex").slice(0, 16);
  fs.writeFileSync(
    path.join(obsidianUserDataDir, "obsidian.json"),
    JSON.stringify({
      vaults: {
        // `trusted: true` skips the "Trust author" modal on Obsidian 1.8+.
        [vaultId]: { path: VAULT_PATH, ts: Date.now(), open: true, trusted: true },
      },
      // Don't let Obsidian auto-update mid-run (it hot-swaps obsidian.asar
      // and unloads the plugin, breaking long-running specs).
      updateDisabled: true,
    }, null, 2),
  );

  const port = await freePort();
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

  // Write resolved data.json.
  fs.writeFileSync(
    path.join(PLUGIN_OUT, "data.json"),
    JSON.stringify({ daemonUrl: `http://127.0.0.1:${port}` }, null, 2),
  );

  // Spawn daemon.
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    VOID_OS_PORT: String(port),
    VOID_OS_HOST: "127.0.0.1",
    VOID_OS_DB: dbPath,
    VOID_OS_VAULT_ROOT: daemonVault,
    VOS_PROVIDER: "fake",
    VOS_TITLER: "stub",
    VOS_FAKE_SCRIPT: fakeScriptPath,
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.VOID_KEYS_URL;

  const daemon: ChildProcess = spawn("bun", ["run", "src/index.ts"], {
    cwd: DAEMON_ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
  });

  try {
    await waitForReady(port, 10_000);
  } catch (err) {
    daemon.kill("SIGKILL");
    throw err;
  }

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

  try {
    await waitForCdp(cdpPort, 20_000);
  } catch (err) {
    obsidian.kill("SIGKILL");
    daemon.kill("SIGKILL");
    throw err;
  }

  const state = {
    port,
    cdpPort,
    daemonPid: daemon.pid,
    obsidianPid: obsidian.pid,
    tmpdir,
    vaultPath: VAULT_PATH,
    obsidianUserDataDir,
    fakeScriptPath,
  };
  const statePath = path.join(tmpdir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.env.VOS_E2E_STATE = statePath;
}
