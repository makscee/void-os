import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDir, tokenPath, pidPath, portPath, logPath, ensureStateDir } from "./state-dir.ts";

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-state-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("stateDir respects current HOME (not cached)", () => {
  // Bun's os.homedir() caches at startup — the lib must use process.env.HOME.
  expect(stateDir()).toBe(join(tmp, ".void-os"));
});

test("path helpers point under stateDir", () => {
  expect(tokenPath()).toBe(join(tmp, ".void-os", "token"));
  expect(pidPath()).toBe(join(tmp, ".void-os", "daemon.pid"));
  expect(portPath()).toBe(join(tmp, ".void-os", "daemon.port"));
  expect(logPath()).toBe(join(tmp, ".void-os", "daemon.log"));
});

test("ensureStateDir creates dir if missing", () => {
  const dir = ensureStateDir();
  expect(dir).toBe(join(tmp, ".void-os"));
  // Re-call must be idempotent.
  ensureStateDir();
});
