import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
    env: { ...process.env, HOME: tmp },
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
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
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
    const r = spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 15000 });
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
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("stopped");
  expect(existsSync(join(tmp, ".void-os/daemon.pid"))).toBe(false);
  expect(existsSync(join(tmp, ".void-os/daemon.port"))).toBe(false);
});

test("stop with no pid file is idempotent (not running, exit 0)", async () => {
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("not running");
});

test("stop with stale pid file (live PID, no daemon) treats as stale (exit 0, no signal)", async () => {
  // Plant pid of *this* test process (definitely alive but not a void-os daemon).
  mkdirSync(join(tmp, ".void-os"), { recursive: true });
  writeFileSync(join(tmp, ".void-os/daemon.pid"), String(process.pid));
  writeFileSync(join(tmp, ".void-os/daemon.port"), String(port));
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("stale pid");
  // Test process must still be alive (test reaches this line).
  expect(true).toBe(true);
});

test("status when stopped prints stopped, exit 0", async () => {
  const r = spawnSync(BIN, ["daemon", "status"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("stopped");
});

test("status when stopped --json", async () => {
  const r = spawnSync(BIN, ["daemon", "status", "--json"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ running: false });
});

test("status when running prints pid/port/vault/version", async () => {
  const vault = join(tmp, "vault");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "status"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  // Implementation pads keys for alignment; assert on the value being present
  // alongside its key, tolerant of whitespace.
  expect(r.stdout).toMatch(new RegExp(`port:\\s+${port}`));
  expect(r.stdout).toMatch(new RegExp(`vault:\\s+${vault.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}`));
  spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
});

test("logs --tail prints last N lines from log file", () => {
  mkdirSync(join(tmp, ".void-os"), { recursive: true });
  const lp = join(tmp, ".void-os/daemon.log");
  writeFileSync(lp, "L1\nL2\nL3\nL4\nL5\nL6\n");
  const r = spawnSync(BIN, ["daemon", "logs", "--tail", "3"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  const lines = r.stdout.trim().split("\n");
  expect(lines.slice(-3)).toEqual(["L4", "L5", "L6"]);
});

test("logs without file prints message + exit 0", () => {
  const r = spawnSync(BIN, ["daemon", "logs"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain("no daemon log yet");
});
