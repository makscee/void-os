import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VOS_ROOT = resolve(__dirname, "..");
const BIN = join(VOS_ROOT, "bin/void-os");

let tmp: string;
let origHome: string | undefined;
let port: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-vault-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
  port = 18000 + Math.floor(Math.random() * 1000);
});

afterEach(() => {
  spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("vault read writes content byte-exact (with trailing newline)", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "notes.md"), "hello\n");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "read", "notes.md"], { env: { ...process.env, HOME: tmp }, encoding: "buffer", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout.toString("utf8")).toBe("hello\n");
});

test("vault read byte-exact (no trailing newline)", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "raw.txt"), "hi");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "read", "raw.txt"], { env: { ...process.env, HOME: tmp }, encoding: "buffer", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout.toString("utf8")).toBe("hi");
});

test("vault write --content writes file", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "write", "out.md", "--content", "world"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("wrote out.md");
  expect(readFileSync(join(vault, "out.md"), "utf8")).toBe("world");
});

test("vault write rejects multiple sources", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "write", "x.md", "--content", "a", "--stdin"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("exactly one source");
});

test("vault write rejects zero sources", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "write", "x.md"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("exactly one source");
});

test("vault list prints one path per line", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "a.md"), "a");
  writeFileSync(join(vault, "b.md"), "b");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "list"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  // Daemon vault/list returns entries with name field; CLI prints one per line.
  expect(r.stdout).toContain("a.md");
  expect(r.stdout).toContain("b.md");
});
