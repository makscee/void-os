import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
