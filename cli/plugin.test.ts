import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VOS_ROOT = resolve(__dirname, "..");
const BIN = join(VOS_ROOT, "bin/void-os");

let tmp: string;
let prefix: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-plugin-"));
  prefix = join(tmp, "prefix");
  // Mirror enough of the void-os layout so the dispatcher loads cli/plugin.ts from prefix.
  mkdirSync(join(prefix, "cli"), { recursive: true });
  mkdirSync(join(prefix, "plugin/dist"), { recursive: true });
  // Symlink cli/ contents from real workspace so we don't duplicate code.
  const realCli = resolve(__dirname);
  for (const f of ["plugin.ts", "lib"]) {
    Bun.spawnSync(["ln", "-sf", join(realCli, f), join(prefix, "cli", f)]);
  }
  writeFileSync(join(prefix, "plugin/dist/manifest.json"), JSON.stringify({ id: "void-os", version: "0.1.0" }));
  writeFileSync(join(prefix, "plugin/dist/main.js"), "// build artifact");
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("plugin install --vault copies dist tree, exits 0", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const r = spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("installed plugin");
  const target = join(vault, ".obsidian/plugins/void-os/manifest.json");
  expect(existsSync(target)).toBe(true);
  expect(JSON.parse(readFileSync(target, "utf8")).version).toBe("0.1.0");
});

test("plugin install idempotent: second run is up-to-date", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  const r = spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("up-to-date");
});

test("plugin install --force overwrites", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  const r = spawnSync(BIN, ["plugin", "install", "--vault", vault, "--force"], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("installed plugin");
});

test("plugin install without --vault and daemon down exits 3", () => {
  const r = spawnSync(BIN, ["plugin", "install"], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(3);
});

test("plugin install with missing dist exits 1", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  rmSync(join(prefix, "plugin/dist"), { recursive: true, force: true });
  const r = spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("plugin not built");
});

test("plugin status missing target", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const r = spawnSync(BIN, ["plugin", "status", "--vault", vault, "--json"], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  const body = JSON.parse(r.stdout);
  expect(body.status).toBe("missing");
});

test("plugin status up-to-date after install", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  const r = spawnSync(BIN, ["plugin", "status", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("up-to-date");
});

test("plugin status upgrade-available when target older", () => {
  const vault = join(tmp, "vault");
  const target = join(vault, ".obsidian/plugins/void-os");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "manifest.json"), JSON.stringify({ id: "void-os", version: "0.0.1" }));
  const r = spawnSync(BIN, ["plugin", "status", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("upgrade-available");
});
