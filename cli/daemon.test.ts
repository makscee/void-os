import { test, describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readPidJson, writePidJson } from "./lib/state-dir.ts";
import { cmdStart, isPidAlive } from "./daemon.ts";

// VOS-134: daemon now pre-flights the CC wrapper at boot. Tests don't care
// which binary it is — `/bin/sh` is always present and just needs to exist.
// We scope the override to spawned child processes via `env:` to avoid leaking
// into other test files (notably daemon/test/cc-helper.test.ts which expects
// the real PATH-resolved claudev).
const CC_BIN = process.env.VOID_OS_CC_BIN ?? "/bin/sh";

const VOS_ROOT = resolve(__dirname, "..");
const BIN = join(VOS_ROOT, "bin/void-os");

let tmp: string;
let origHome: string | undefined;
let origPort: string | undefined;
let port: number;

function pickPort(): number {
  // Avoid collision with default 7777 + other tests by drawing from 18000-18999.
  return 18000 + Math.floor(Math.random() * 1000);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-daemon-"));
  origHome = process.env.HOME;
  origPort = process.env.VOID_OS_PORT;
  process.env.HOME = tmp;
  port = pickPort();
});

afterEach(() => {
  // Best-effort kill any leftover daemon for this HOME.
  const pidFile = join(tmp, ".void-os/daemon.pid");
  if (existsSync(pidFile)) {
    try { process.kill(parseInt(readFileSync(pidFile, "utf8"), 10), "SIGKILL"); } catch {}
  }
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  if (origPort !== undefined) process.env.VOID_OS_PORT = origPort; else delete process.env.VOID_OS_PORT;
  rmSync(tmp, { recursive: true, force: true });
});

test("start writes pid + port and /health returns ready", async () => {
  const vault = join(tmp, "vault");
  // intentionally do NOT mkdir vault — start must create it.
  const r = spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], {
    env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("void-os daemon ready");
  expect(existsSync(join(tmp, ".void-os/daemon.pid"))).toBe(true);
  expect(readFileSync(join(tmp, ".void-os/daemon.port"), "utf8").trim()).toBe(String(port));
  expect(existsSync(vault)).toBe(true);
});

test("second start prints already running", async () => {
  const vault = join(tmp, "vault");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("already running");
});

test("start with port already in use exits 1 quickly (child-exit race)", async () => {
  const vault = join(tmp, "vault");
  // Occupy the chosen port with a tiny non-/health listener running in a
  // *separate* bun process. Doing this in-process via Bun.serve causes any
  // subsequently spawned `bin/void-os` to hang for unknown reasons (parent
  // socket interaction). A standalone subprocess sidesteps it.
  // Reply 503 on every path so /health probes never look "ok".
  const blocker = Bun.spawn({
    cmd: ["bun", "-e", `Bun.serve({port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("blocked", {status: 503})}); await new Promise(r => setTimeout(r, 60000));`],
    stdout: "ignore",
    stderr: "ignore",
  });
  // Give the blocker a moment to bind.
  await new Promise((r) => setTimeout(r, 300));
  try {
    const t0 = Date.now();
    const r = spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 15000 });
    const elapsed = Date.now() - t0;
    expect(r.status).not.toBe(0);
    // Should bail early (< 7 s), not wait the full 10 s poll timeout.
    expect(elapsed).toBeLessThan(7000);
  } finally {
    try { blocker.kill(); } catch {}
  }
});

test("stop removes pid/port files and exits 0", async () => {
  const vault = join(tmp, "vault");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("stopped");
  expect(existsSync(join(tmp, ".void-os/daemon.pid"))).toBe(false);
  expect(existsSync(join(tmp, ".void-os/daemon.port"))).toBe(false);
});

test("stop with no pid file is idempotent (not running, exit 0)", async () => {
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("not running");
});

test("stop with stale pid file (live PID, no daemon) treats as stale (exit 0, no signal)", async () => {
  // Plant pid of *this* test process (definitely alive but not a void-os daemon).
  mkdirSync(join(tmp, ".void-os"), { recursive: true });
  writeFileSync(join(tmp, ".void-os/daemon.pid"), String(process.pid));
  writeFileSync(join(tmp, ".void-os/daemon.port"), String(port));
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("stale pid");
  // Test process must still be alive (test reaches this line).
  expect(true).toBe(true);
});

test("status when stopped prints stopped, exit 0", async () => {
  const r = spawnSync(BIN, ["daemon", "status"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("stopped");
});

test("status when stopped --json", async () => {
  const r = spawnSync(BIN, ["daemon", "status", "--json"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ running: false });
});

test("status when running prints pid/port/vault/version", async () => {
  const vault = join(tmp, "vault");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "status"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  // Implementation pads keys for alignment; assert on the value being present
  // alongside its key, tolerant of whitespace.
  expect(r.stdout).toMatch(new RegExp(`port:\\s+${port}`));
  expect(r.stdout).toMatch(new RegExp(`vault:\\s+${vault.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}`));
  spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 10000 });
});

test("logs --tail prints last N lines from log file", () => {
  mkdirSync(join(tmp, ".void-os"), { recursive: true });
  const lp = join(tmp, ".void-os/daemon.log");
  writeFileSync(lp, "L1\nL2\nL3\nL4\nL5\nL6\n");
  const r = spawnSync(BIN, ["daemon", "logs", "--tail", "3"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  const lines = r.stdout.trim().split("\n");
  expect(lines.slice(-3)).toEqual(["L4", "L5", "L6"]);
});

test("logs without file prints message + exit 0", () => {
  const r = spawnSync(BIN, ["daemon", "logs"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain("no daemon log yet");
});

test("unknown flag exits 2 with clean stderr (no stacktrace)", () => {
  const r = spawnSync(BIN, ["daemon", "status", "--bogus"], { env: { ...process.env, HOME: tmp, VOID_OS_CC_BIN: CC_BIN }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("unknown flag");
  // No raw Bun/Node stacktrace.
  expect(r.stderr).not.toContain("at ");
});

// VOS-120 T2: vault-awareness unit tests for cmdStart's early-exit branches.
// These hit the exported API directly (not via BIN spawn) and use dryRun to
// verify branch selection without spawning bun.
describe("cmdStart vault awareness (VOS-120)", () => {
  it("refuses when an alive daemon serves a different vault", async () => {
    writePidJson({
      pid: process.pid,         // alive
      port: 7777,
      vault_root: "/vault/A",
      version: "0.0.0",
      started_at: new Date().toISOString(),
    });
    const result = await cmdStart({ vault: "/vault/B", dryRun: true });
    expect(result.status).toBe("vault-mismatch");
    if (result.status === "vault-mismatch") {
      expect(result.activeVault).toBe("/vault/A");
      expect(result.pid).toBe(process.pid);
    }
  });

  it("no-ops when an alive daemon serves the same vault", async () => {
    writePidJson({
      pid: process.pid,
      port: 7777,
      vault_root: "/vault/A",
      version: "0.0.0",
      started_at: new Date().toISOString(),
    });
    // VOS-143: cmdStart now also probes /health before attaching. Stub
    // globalThis.fetch so the probe returns 200.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "x" }), { status: 200 })) as typeof globalThis.fetch;
    try {
      const result = await cmdStart({ vault: "/vault/A", dryRun: true });
      expect(result.status).toBe("already-running");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("treats dead-pid pidfile as stale and proceeds", async () => {
    writePidJson({
      pid: 999999,
      port: 7777,
      vault_root: "/vault/A",
      version: "0.0.0",
      started_at: new Date().toISOString(),
    });
    const result = await cmdStart({ vault: "/vault/B", dryRun: true });
    expect(result.status).toBe("would-spawn");
    expect(readPidJson()).toBeNull();
  });

  it("isPidAlive returns true for current process and false for sentinel", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999999)).toBe(false);
  });
});

// VOS-143 T5: liveness now goes through /health, not just isPidAlive. A pid
// that's alive but bound to no port (or to a non-void-os process) must be
// treated as stale so the plugin can recover from a crashed-but-pidfile-left
// daemon. Vault-mismatch still wins precedence over health probe.
describe("cmdStart liveness via /health (VOS-143)", () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("treats pid-alive but health-failing daemon as stale", async () => {
    writePidJson({
      pid: process.pid,         // alive
      port: 7777,
      vault_root: "/vault/A",
      version: "0.0.0",
      started_at: new Date().toISOString(),
    });
    // /health unreachable → fetch throws.
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    const result = await cmdStart({ vault: "/vault/A", dryRun: true });
    // pid alive + unhealthy → cleared pidfile + would-spawn (dryRun).
    expect(result.status).toBe("would-spawn");
    expect(readPidJson()).toBeNull();
  });

  it("attaches when /health returns 200 + same vault", async () => {
    writePidJson({
      pid: process.pid,
      port: 7777,
      vault_root: "/vault/A",
      version: "0.0.0",
      started_at: new Date().toISOString(),
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;

    const result = await cmdStart({ vault: "/vault/A", dryRun: true });
    expect(result.status).toBe("already-running");
    if (result.status === "already-running") {
      expect(result.vault).toBe("/vault/A");
      expect(result.pid).toBe(process.pid);
      expect(result.port).toBe(7777);
    }
  });

  it("vault-mismatch precedence: different vault wins over health probe", async () => {
    writePidJson({
      pid: process.pid,
      port: 7777,
      vault_root: "/vault/A",
      version: "0.0.0",
      started_at: new Date().toISOString(),
    });
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(JSON.stringify({ version: "x" }), { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await cmdStart({ vault: "/vault/B", dryRun: true });
    expect(result.status).toBe("vault-mismatch");
    if (result.status === "vault-mismatch") {
      expect(result.activeVault).toBe("/vault/A");
      expect(result.requestedVault).toBe("/vault/B");
    }
    // Health probe must run before vault check OR not at all — either way
    // the outcome is vault-mismatch when vaults differ.
    void fetched;
  });
});

describe("cmdStartCli message includes vault (VOS-143)", () => {
  it("already-running stdout has vault path", async () => {
    // Drive the structured already-running shape through cmdStart by writing a
    // pidfile + stubbing fetch to /health 200. Then invoke the top-level
    // dispatcher and capture stdout.
    writePidJson({
      pid: process.pid,
      port: 7777,
      vault_root: "/vault/X",
      version: "0.0.0",
      started_at: new Date().toISOString(),
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "x" }), { status: 200 })) as typeof globalThis.fetch;
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      const mod = await import("./daemon.ts");
      const rc = await mod.default(
        ["start", "--port", "7777", "--vault", "/vault/X"],
        { prefix: VOS_ROOT },
      );
      expect(rc).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toMatch(/already running/);
      expect(joined).toMatch(/vault=\/vault\/X/);
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }
  });
});
