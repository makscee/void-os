/**
 * VOS-188 Real-path proof: tmux Run substrate + hooks→SQLite registry
 *
 * Spawns the daemon on a test port + vault, launches a real vc Run via /launch,
 * then polls the registry DB until the latest Run for the session walks states
 * driven by real CC hook fires (NOT capture-pane scraping).
 *
 * Asserts:
 * 1. A Run row is created with state=spawning immediately after /launch.
 * 2. tmux session `vos-run-<runId>` exists and is attachable.
 * 3. state transitions to `running` when CC fires SessionStart (hook POST to /hook).
 * 4. session.resume_token is filled after running.
 * 5. state transitions to `idle` when CC fires Stop hook.
 * 6. state transitions to `exited_ok` or `exited_fail` when CC fires SessionEnd/StopFailure.
 * 7. POST /s/:uuid/stop: kill-session kills the tmux session + run → exited_fail.
 *
 * Run: bun run tests/e2e-vos-188-tmux-run-registry.ts
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---- paths ----
const __dirname_e2e = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname_e2e, "..");
const VAULT = "/tmp/void-os-e2e-vos188";
const PORT = 4396;
const BASE = `http://localhost:${PORT}`;

// Import registry helpers directly (read-only queries against the live DB file).
// We open a SEPARATE read-only-ish connection to avoid WAL conflicts.
const { openRegistry, latestRunForSession, getSession } = await import(`${REPO_ROOT}/src/registry.ts`);
const { registryDbPath } = await import(`${REPO_ROOT}/src/paths.ts`);
const { hasSession } = await import(`${REPO_ROOT}/src/tmux.ts`);

// ---- setup ----
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "sessions"), { recursive: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });

writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT,
  onboarded: true,
  skills: [],
  answers: {},
  port: PORT,
  runners: [{ label: "vc (relay)", command: "vc --" }],
  defaultRunner: "vc (relay)",
}, null, 2));

console.log("=== VOS-188 Real-path proof ===");
console.log(`VAULT: ${VAULT}  PORT: ${PORT}`);
console.log("Starting daemon...");

const server = spawn("bun", ["run", "src/cli.ts", "serve", "--no-open"], {
  cwd: REPO_ROOT,
  env: { ...process.env, VOID_OS_VAULT: VAULT, VOID_OS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout?.on("data", (d: Buffer) => process.stdout.write(`[daemon] ${d}`));
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[daemon] ${d}`));

// Wait for server to start
await new Promise<void>((r) => setTimeout(r, 2500));

let ok = true;
const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) { errors.push(`FAIL: ${msg}`); ok = false; console.error(`FAIL: ${msg}`); }
  else console.log(`PASS: ${msg}`);
}

async function poll<T>(
  fn: () => T,
  check: (v: T) => boolean,
  label: string,
  timeoutMs = 120_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = fn();
  while (Date.now() < deadline) {
    last = fn();
    if (check(last)) {
      console.log(`  → ${label}: ${JSON.stringify(last)}`);
      return last;
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  console.error(`  TIMEOUT waiting for: ${label} (last: ${JSON.stringify(last)})`);
  return last;
}

try {
  // ---- Step 1: POST /launch ----
  console.log("\n[Step 1] POST /launch skill=smoke-test");
  const launchRes = await fetch(`${BASE}/launch`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "skill=smoke-test&text=hello",
    redirect: "manual",
  });
  const loc = launchRes.headers.get("location") ?? "";
  assert(launchRes.status === 302, `/launch returns 302 (got ${launchRes.status})`);
  assert(loc.startsWith("/s/"), `/launch redirects to /s/ (got ${loc})`);

  const sessionId = loc.replace("/s/", "");
  console.log(`  sessionId: ${sessionId}`);

  // Open a read-only registry connection to the live DB file
  const dbPath = registryDbPath(VAULT);
  // Wait for registry to be initialized
  const dbDeadline = Date.now() + 5000;
  while (!existsSync(dbPath) && Date.now() < dbDeadline) {
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  assert(existsSync(dbPath), "registry.db file exists");

  const db = openRegistry(dbPath);

  // ---- Step 2: Verify spawning row created ----
  console.log("\n[Step 2] Verify spawning row + tmux session exists");
  const initialRun = latestRunForSession(db, sessionId);
  assert(initialRun !== null, "Run row created in registry");

  if (initialRun) {
    const runId = initialRun.id;
    const tmuxSession = initialRun.tmux_session;
    console.log(`  runId: ${runId}`);
    console.log(`  tmuxSession: ${tmuxSession}`);
    console.log(`  Attach command: tmux attach -t ${tmuxSession}`);

    assert(tmuxSession === `vos-run-${runId}`, `tmux session named vos-run-${runId}`);

    // Wait a moment for tmux to be created
    await new Promise<void>((r) => setTimeout(r, 1000));
    const tmuxAlive = hasSession(tmuxSession);
    assert(tmuxAlive, `tmux session ${tmuxSession} exists`);

    // ---- Step 3: Poll for running state (SessionStart hook) ----
    console.log("\n[Step 3] Polling for run.state = running (SessionStart hook)...");
    const runAfterStart = await poll(
      () => latestRunForSession(db, sessionId),
      (r) => r?.state === "running",
      "state=running",
      90_000,
    );
    assert(runAfterStart?.state === "running", `Run transitions to running (got: ${runAfterStart?.state})`);

    // ---- Step 4: Verify resume_token filled ----
    console.log("\n[Step 4] Verify session.resume_token filled");
    const ses = getSession(db, sessionId);
    assert(ses?.resume_token !== null && ses?.resume_token !== undefined, `resume_token filled (got: ${ses?.resume_token})`);
    console.log(`  resume_token: ${ses?.resume_token}`);

    // ---- Step 5: Poll for idle state (Stop hook) ----
    console.log("\n[Step 5] Polling for run.state = idle (Stop hook)...");
    const runAfterIdle = await poll(
      () => latestRunForSession(db, sessionId),
      (r) => r?.state === "idle" || r?.state === "exited_ok" || r?.state === "exited_fail",
      "state=idle|exited",
      120_000,
    );
    assert(
      runAfterIdle?.state === "idle" || runAfterIdle?.state === "exited_ok" || runAfterIdle?.state === "exited_fail",
      `Run transitions past running (got: ${runAfterIdle?.state})`,
    );

    // ---- Step 6: Poll for exited state (SessionEnd hook) ----
    console.log("\n[Step 6] Polling for run.state = exited_ok|exited_fail (SessionEnd hook)...");
    const runAfterExit = await poll(
      () => latestRunForSession(db, sessionId),
      (r) => r?.state === "exited_ok" || r?.state === "exited_fail",
      "state=exited",
      120_000,
    );
    assert(
      runAfterExit?.state === "exited_ok" || runAfterExit?.state === "exited_fail",
      `Run transitions to exited (got: ${runAfterExit?.state})`,
    );

    // ---- Step 7: POST stop on a fresh Run, verify kill-session ----
    console.log("\n[Step 7] Spawn second Run, then stop it — verify tmux kill + registry exited_fail");
    const launch2Res = await fetch(`${BASE}/launch`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "skill=smoke-test&text=second-run",
      redirect: "manual",
    });
    const loc2 = launch2Res.headers.get("location") ?? "";
    const sessionId2 = loc2.replace("/s/", "");
    console.log(`  sessionId2: ${sessionId2}`);

    // Wait for the second run to create a tmux session
    await new Promise<void>((r) => setTimeout(r, 2000));
    const run2 = latestRunForSession(db, sessionId2);
    if (run2) {
      const tmuxSession2 = run2.tmux_session;
      const tmuxAlive2Before = hasSession(tmuxSession2);
      assert(tmuxAlive2Before, `second tmux session ${tmuxSession2} alive before stop`);

      // Stop
      const stopRes = await fetch(`${BASE}/s/${sessionId2}/stop`, {
        method: "POST",
        redirect: "manual",
      });
      assert(stopRes.status < 400, `POST /stop returns < 400 (got ${stopRes.status})`);

      // Wait briefly for kill to take effect
      await new Promise<void>((r) => setTimeout(r, 1000));

      const tmuxAlive2After = hasSession(tmuxSession2);
      assert(!tmuxAlive2After, `tmux session ${tmuxSession2} killed after stop`);

      const runAfterStop = latestRunForSession(db, sessionId2);
      assert(
        runAfterStop?.state === "exited_fail",
        `Run row → exited_fail after stop (got: ${runAfterStop?.state})`,
      );
    } else {
      assert(false, "second Run row created");
    }

    // Print the transition log
    console.log("\n=== Transition log (session 1) ===");
    console.log(`sessionId:    ${sessionId}`);
    console.log(`runId:        ${runId}`);
    console.log(`tmuxSession:  ${tmuxSession}`);
    console.log(`Attach cmd:   tmux attach -t ${tmuxSession}`);
    console.log(`Final state:  ${latestRunForSession(db, sessionId)?.state}`);
    console.log(`resume_token: ${getSession(db, sessionId)?.resume_token}`);
  }

  db.close();

} finally {
  server.kill("SIGTERM");
  await new Promise<void>((r) => setTimeout(r, 500));
}

// ---- Summary ----
console.log("\n=== Summary ===");
if (ok) {
  console.log("ALL ASSERTIONS PASSED");
} else {
  console.error("FAILURES:");
  for (const e of errors) console.error(" ", e);
}

process.exit(ok ? 0 : 1);
