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
import { ensureObsidian } from "./obsidian-cache.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const DAEMON_ROOT = path.resolve(HERE, "..", "..", "daemon");
const FIXTURE_VAULT = path.join(HERE, "fixtures", "vault");
const DAEMON_FIXTURE_VAULT = path.join(HERE, "fixtures", "daemon-vault");
const FAKE_SCRIPT = path.join(HERE, "fixtures", "cc", "hello.jsonl");
// VOS-89 T16: per-agent fake-provider scripts for the ask_agent E2E.
// These are forwarded to the daemon as VOS_FAKE_SCRIPT_<agent> env vars
// so the fake provider factory (resolveFakeScript) picks them per child.
const ASK_AGENT_MAYA_SCRIPT = path.join(HERE, "fixtures", "ask-agent", "maya.jsonl");
// VOS-91 T18: richer journaler fixture (chunk-1/chunk-2/noop/final-answer-A)
// used by both ask_agent and ask-agent-subthread specs. ask-agent.spec.ts
// asserts toContain("A") so final-answer-A still satisfies it.
const ASK_AGENT_JOURNALER_SCRIPT = path.join(HERE, "fixtures", "ask-agent-subthread", "journaler.jsonl");

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

  // VOS-89 T16: seed vault/agents/maya + vault/agents/journaler so the daemon's
  // boot-time vault scanner (src/index.ts) populates the `agents` table for
  // both. The DAEMON's vault root is `daemonVault` (set below), NOT the
  // Obsidian fixture vault, so the agent files must live there.
  const daemonAgentsDir = path.join(daemonVault, "agents");
  fs.mkdirSync(path.join(daemonAgentsDir, "maya"), { recursive: true });
  fs.mkdirSync(path.join(daemonAgentsDir, "journaler"), { recursive: true });
  fs.writeFileSync(
    path.join(daemonAgentsDir, "maya", "agent.md"),
    "---\nname: maya\ndescription: front desk\nmodel: opus\n---\n",
  );
  fs.writeFileSync(
    path.join(daemonAgentsDir, "journaler", "agent.md"),
    "---\nname: journaler\ndescription: journal helper\nmodel: haiku\n---\n",
  );

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
    VOS_FAKE_SCRIPT_maya: ASK_AGENT_MAYA_SCRIPT,
    VOS_FAKE_SCRIPT_journaler: ASK_AGENT_JOURNALER_SCRIPT,
    VOS_FAKE_PER_EVENT_DELAY_MS_maya: "200",
    // VOS-91 T18: slow journaler events so WORKING state is observable in UI.
    VOS_FAKE_PER_EVENT_DELAY_MS_journaler: "200",
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

  // VOS-89 T16: seed agent_cards for maya + journaler. Production code
  // does NOT (yet) populate agent_cards from the vault scan — the ask_agent handler's
  // existence check (SELECT 1 FROM agent_cards WHERE agent_name = ?) would
  // otherwise reject the call. This seeding step mirrors what
  // bootInProcessDaemon does in daemon/test/helpers/boot-daemon.ts. We use
  // node:sqlite (Playwright runs under Node, not Bun) against the daemon's
  // DB file; safe because at this point the daemon has finished migrations
  // + initial boot work, and INSERT OR IGNORE means re-runs are idempotent.
  {
    const { DatabaseSync } = await import("node:sqlite");
    const seedDb = new DatabaseSync(dbPath);
    try {
      const stmt = seedDb.prepare(
        "INSERT OR IGNORE INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      );
      stmt.run("maya", JSON.stringify({ name: "maya" }));
      stmt.run("journaler", JSON.stringify({ name: "journaler" }));
    } finally {
      seedDb.close();
    }
  }

  // Spawn Obsidian (from local cache) with CDP debugger + fixture vault.
  let obsidianBin: string;
  try {
    obsidianBin = await ensureObsidian();
  } catch (err) {
    daemon.kill("SIGKILL");
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
    dbPath,
  };
  const statePath = path.join(tmpdir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.env.VOS_E2E_STATE = statePath;
}
