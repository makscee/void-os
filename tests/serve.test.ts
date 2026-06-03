/**
 * serve.ts — unit tests for port + vault resolution logic and the chat bus interceptor.
 * These test the pure exported functions without starting Bun.serve.
 */
import { expect, test } from "bun:test";
import { resolvePort, resolveVault, handleChatBusLine, isPortInUse } from "../src/serve.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, upsertTrigger } from "../src/registry.ts";
import { chatThreadPath } from "../src/paths.ts";
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

// --- isPortInUse (VOS-229) ---

test("isPortInUse detects an error with code EADDRINUSE", () => {
  expect(isPortInUse({ code: "EADDRINUSE", message: "whatever" })).toBe(true);
});

test("isPortInUse detects Bun's 'Is port N in use?' message", () => {
  expect(isPortInUse(new Error("Failed to start server. Is port 14405 in use?"))).toBe(true);
});

test("isPortInUse detects 'address already in use' phrasing", () => {
  expect(isPortInUse(new Error("listen: address already in use :::4317"))).toBe(true);
});

test("isPortInUse returns false for unrelated errors", () => {
  expect(isPortInUse(new Error("some other failure"))).toBe(false);
  expect(isPortInUse({ code: "ENOENT" })).toBe(false);
  expect(isPortInUse(null)).toBe(false);
  expect(isPortInUse("a string")).toBe(false);
});

// Integration: the error Bun.serve actually throws on a taken port is one isPortInUse matches.
// This is the load-bearing wiring check — it proves the real EADDRINUSE the operator hit is
// classified as "graceful path" and never escapes as an uncaught throw.
test("Bun.serve EADDRINUSE on a taken port is classified by isPortInUse (not a raw crash)", () => {
  const first = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const takenPort = first.port;
  let classified = false;
  let threw = false;
  try {
    Bun.serve({ port: takenPort, hostname: "127.0.0.1", fetch: () => new Response("ok2") });
  } catch (err) {
    threw = true;
    classified = isPortInUse(err);
  } finally {
    first.stop(true);
  }
  // Hard-fail: Bun must throw AND our detector must catch it.
  expect(threw).toBe(true);
  expect(classified).toBe(true);
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

// --- handleChatBusLine — serve.ts bus interceptor ---

function mkTestVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vos-serve-test-"));
  mkdirSync(join(v, "chat"), { recursive: true });
  mkdirSync(join(v, ".void-os", "bus"), { recursive: true });
  return v;
}

function writeBusLineFile(vault: string, id: string, obj: Record<string, unknown>): string {
  const path = join(vault, ".void-os", "bus", `${id}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

test("handleChatBusLine returns false when inputRef is null", () => {
  const vault = mkTestVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "chat", kind: "event", skill: "chat", agent: "default", cronExpr: null, inbox: "bus", stepCeiling: 30, now: 0 });
  const calls: unknown[] = [];
  const fakeSpawn = (o: unknown) => { calls.push(o); return { runId: "r", sessionId: "s", tmuxSession: "t" }; };
  const result = handleChatBusLine(vault, db, "chat", "some input", null, fakeSpawn as any, 1000);
  expect(result).toBe(false);
  expect(calls.length).toBe(0);
});

test("handleChatBusLine returns false for a non-chat kind=idea bus line", () => {
  const vault = mkTestVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "idea", kind: "event", skill: "idea-capture", agent: "default", cronExpr: null, inbox: "bus", stepCeiling: 10, now: 0 });
  const calls: unknown[] = [];
  const fakeSpawn = (o: unknown) => { calls.push(o); return { runId: "r", sessionId: "s", tmuxSession: "t" }; };
  const refPath = writeBusLineFile(vault, "bl-idea-1", { channel: "file", kind: "idea", payload: "interesting idea", routing: {}, id: "bl-idea-1", ts: 1000 });
  const result = handleChatBusLine(vault, db, "idea", "interesting idea", refPath, fakeSpawn as any, 1000);
  expect(result).toBe(false);
  expect(calls.length).toBe(0);
});

test("handleChatBusLine deposits user turn and fires trigger for a valid kind=chat bus line", () => {
  const vault = mkTestVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "chat", kind: "event", skill: "chat", agent: "default", cronExpr: null, inbox: "bus", stepCeiling: 30, now: 0 });
  const calls: any[] = [];
  const fakeSpawn = (o: any) => { calls.push(o); return { runId: "r", sessionId: "s", tmuxSession: "t" }; };
  const refPath = writeBusLineFile(vault, "bl-chat-1", {
    channel: "file", kind: "chat", payload: "hello from bus",
    routing: { thread: "general" }, id: "bl-chat-1", ts: 5000,
  });
  const result = handleChatBusLine(vault, db, "chat", "hello from bus", refPath, fakeSpawn as any, 5000);
  // Returns true: chat path taken
  expect(result).toBe(true);
  // User turn deposited into thread file BEFORE spawn
  const threadContent = readFileSync(chatThreadPath(vault, "general"), "utf8");
  expect(threadContent).toContain("## user");
  expect(threadContent).toContain("hello from bus");
  // fireTrigger called with input = thread file path (NOT the original payload)
  expect(calls.length).toBe(1);
  expect(calls[0].input).toBe(chatThreadPath(vault, "general"));
  expect(calls[0].inputRef).toBe(chatThreadPath(vault, "general"));
});

test("handleChatBusLine returns false when routing.thread is missing", () => {
  const vault = mkTestVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "chat", kind: "event", skill: "chat", agent: "default", cronExpr: null, inbox: "bus", stepCeiling: 30, now: 0 });
  const calls: unknown[] = [];
  const fakeSpawn = (o: unknown) => { calls.push(o); return { runId: "r", sessionId: "s", tmuxSession: "t" }; };
  const refPath = writeBusLineFile(vault, "bl-chat-2", {
    channel: "file", kind: "chat", payload: "no thread",
    routing: {}, id: "bl-chat-2", ts: 6000,
  });
  const result = handleChatBusLine(vault, db, "chat", "no thread", refPath, fakeSpawn as any, 6000);
  expect(result).toBe(false);
  expect(calls.length).toBe(0);
  expect(existsSync(chatThreadPath(vault, "general"))).toBe(false);
});

test("handleChatBusLine returns false when inputRef file is missing (no crash)", () => {
  const vault = mkTestVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "chat", kind: "event", skill: "chat", agent: "default", cronExpr: null, inbox: "bus", stepCeiling: 30, now: 0 });
  const calls: unknown[] = [];
  const fakeSpawn = (o: unknown) => { calls.push(o); return { runId: "r", sessionId: "s", tmuxSession: "t" }; };
  const result = handleChatBusLine(vault, db, "chat", "input", join(vault, ".void-os", "bus", "nonexistent.json"), fakeSpawn as any, 1000);
  expect(result).toBe(false);
  expect(calls.length).toBe(0);
});
