import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VOS_ROOT = resolve(__dirname, "..");
const BIN = join(VOS_ROOT, "bin/void-os");

let tmp: string;
let origHome: string | undefined;
let port: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-agents-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
  port = 18000 + Math.floor(Math.random() * 1000);
});

afterEach(() => {
  spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("agents list against running daemon (--json)", async () => {
  const vault = join(tmp, "vault");
  // VOS-137: `daemon start --vault` requires marker.json.
  mkdirSync(join(vault, ".void"), { recursive: true });
  writeFileSync(join(vault, ".void/marker.json"), JSON.stringify({ version: 1 }));
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["agents", "list", "--json"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  const body = JSON.parse(r.stdout);
  expect(Array.isArray(body.agents)).toBe(true);
});

test("agents list against no daemon exits 3", () => {
  const r = spawnSync(BIN, ["agents", "list"], { env: { ...process.env, HOME: tmp, VOID_OS_BASE: `http://127.0.0.1:${port}`, VOID_OS_TOKEN: "x" }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(3);
});

// VOS-165: prune-branches subcommand.
test("agents prune-branches rejects a negative --older-than (exit 2)", () => {
  const r = spawnSync(BIN, ["agents", "prune-branches", "--older-than", "-5"], { env: { ...process.env, HOME: tmp, VOID_OS_BASE: `http://127.0.0.1:${port}`, VOID_OS_TOKEN: "x" }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("--older-than");
});

test("agents prune-branches against no daemon exits 3", () => {
  const r = spawnSync(BIN, ["agents", "prune-branches"], { env: { ...process.env, HOME: tmp, VOID_OS_BASE: `http://127.0.0.1:${port}`, VOID_OS_TOKEN: "x" }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(3);
});
