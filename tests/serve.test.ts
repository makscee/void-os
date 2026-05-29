/**
 * serve.ts — unit tests for port + vault resolution logic.
 * These test the pure exported functions without starting Bun.serve.
 */
import { expect, test } from "bun:test";
import { resolvePort, resolveVault } from "../src/serve.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// --- resolvePort ---

test("resolvePort defaults to config port when no flag/env", () => {
  expect(resolvePort([], {}, 4317)).toBe(4317);
});

test("resolvePort uses --port flag over config", () => {
  expect(resolvePort(["serve", "--port", "5000"], {}, 4317)).toBe(5000);
});

test("resolvePort uses VOID_OS_PORT env over config", () => {
  expect(resolvePort([], { VOID_OS_PORT: "6000" }, 4317)).toBe(6000);
});

test("resolvePort flag takes priority over env", () => {
  expect(resolvePort(["--port", "5500"], { VOID_OS_PORT: "6000" }, 4317)).toBe(5500);
});

test("resolvePort ignores non-numeric --port value and falls back", () => {
  // NaN from parseInt → fallback to env or config
  expect(resolvePort(["--port", "abc"], { VOID_OS_PORT: "4444" }, 4317)).toBe(4444);
});

test("resolvePort ignores missing --port value and falls back", () => {
  expect(resolvePort(["--port"], {}, 4317)).toBe(4317);
});

// --- resolveVault ---

const TMP_VAULT = "/tmp/voidos-serve-vault-test";

test("resolveVault uses VOID_OS_VAULT env", () => {
  expect(resolveVault({ VOID_OS_VAULT: "/my/vault" }, "/cwd")).toBe("/my/vault");
});

test("resolveVault detects vault at cwd if void-os.json present", () => {
  mkdirSync(TMP_VAULT, { recursive: true });
  writeFileSync(join(TMP_VAULT, "void-os.json"), "{}");
  try {
    expect(resolveVault({}, TMP_VAULT)).toBe(TMP_VAULT);
  } finally {
    rmSync(TMP_VAULT, { recursive: true, force: true });
  }
});

test("resolveVault falls back to ~/void-os when no cwd marker", () => {
  const result = resolveVault({ HOME: "/home/testuser" }, "/some/random/cwd");
  expect(result).toBe("/home/testuser/void-os");
});

test("resolveVault uses HOME fallback /tmp when HOME absent", () => {
  const result = resolveVault({}, "/cwd");
  expect(result).toBe("/tmp/void-os");
});
