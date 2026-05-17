/**
 * Integration tests for `cli/ask.ts` against a mock daemon (Bun.serve).
 *
 * Mirrors the test pattern from cli/agents.test.ts but exercises the in-process
 * handler directly so we can assert on injected stdout/stderr without spawning
 * a child process. The mock daemon implements the subset of endpoints the ask
 * handler touches: /health, /agents, POST /chats, POST /chat/:id/message,
 * GET /chat/:id/stream.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import ask from "../ask.ts";

type Frame = { event: string; data: unknown };

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = "";
let scenario:
  | "happy"
  | "happy_with_tool"
  | "ask_user"
  | "agent_unknown"
  | "daemon_down" = "happy";

function sseBody(frames: Frame[]): ReadableStream {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctl) {
      // Match daemon's SSE shape: data-only event with the typed event name
      // embedded in the JSON. The protocol client extracts the `event` field
      // from the JSON payload (sseFrames yields the parsed JSON object).
      for (const f of frames) {
        const payload = JSON.stringify({ event: f.event, data: f.data });
        ctl.enqueue(enc.encode(`event: ${f.event}\ndata: ${payload}\n\n`));
      }
      ctl.close();
    },
  });
}

function startServer() {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          version: "test",
          vault_root: "/tmp/vault",
          uptime_s: 1,
          sessions: 0,
        });
      }
      if (url.pathname === "/agents") {
        if (scenario === "agent_unknown") return Response.json({ agents: [] });
        return Response.json({
          agents: [{ name: "tinker", description: "test agent" }],
        });
      }
      if (url.pathname === "/chats" && req.method === "POST") {
        return Response.json({ id: "c1", title: "t", created_at: 1 });
      }
      if (url.pathname === "/chat/c1/message" && req.method === "POST") {
        return Response.json({ run_id: "r1" });
      }
      if (url.pathname === "/chat/c1/stream") {
        let frames: Frame[];
        if (scenario === "ask_user") {
          frames = [
            { event: "hello", data: { chat_id: "c1", version: "1" } },
            { event: "text", data: { text: "before " } },
            { event: "ask_user", data: { tool_use_id: "tu1", prompt: "name?" } },
          ];
        } else if (scenario === "happy_with_tool") {
          frames = [
            { event: "hello", data: { chat_id: "c1", version: "1" } },
            {
              event: "tool_use",
              data: { name: "vault.read", input: { path: "x.md" } },
            },
            { event: "tool_result", data: { ok: true, size: 42 } },
            { event: "text", data: { text: "pong" } },
            { event: "run_end", data: {} },
          ];
        } else {
          frames = [
            { event: "hello", data: { chat_id: "c1", version: "1" } },
            { event: "text", data: { text: "pong" } },
            { event: "run_end", data: {} },
          ];
        }
        return new Response(sseBody(frames), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  process.env.VOID_OS_BASE = baseUrl;
  process.env.VOID_OS_TOKEN = "test-token";
}

beforeEach(() => {
  if (scenario !== "daemon_down") startServer();
});

afterEach(() => {
  if (server) {
    server.stop();
    server = undefined;
  }
  delete process.env.VOID_OS_BASE;
  delete process.env.VOID_OS_TOKEN;
});

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: {
        write: (s: string) => {
          out.push(s);
          return true;
        },
        isTTY: false,
      },
      stderr: {
        write: (s: string) => {
          err.push(s);
          return true;
        },
        isTTY: false,
      },
    },
  };
}

test("happy path returns 0 and prints buffered final text with trailing newline", async () => {
  scenario = "happy";
  startServer();
  const cap = captureIo();
  const code = await ask(["tinker", "ping"], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join("")).toBe("pong\n");
});

test("happy path with tool renders tool one-liner live, text buffered until run_end", async () => {
  scenario = "happy_with_tool";
  startServer();
  const cap = captureIo();
  const code = await ask(["tinker", "ping"], cap.io);
  expect(code).toBe(0);
  // tool one-liner appears before the buffered text
  const joined = cap.out.join("");
  expect(joined).toBe("· vault.read x.md\n  ↳ ok (42 B)\npong\n");
});

test("--stream mode writes text as received (no buffering)", async () => {
  scenario = "happy";
  startServer();
  const cap = captureIo();
  const code = await ask(["tinker", "ping", "--stream"], cap.io);
  expect(code).toBe(0);
  // stream mode: text emitted directly, no buffer-with-newline appended
  expect(cap.out.join("")).toContain("pong");
});

test("agent unknown returns 4 with actionable message", async () => {
  scenario = "agent_unknown";
  startServer();
  const cap = captureIo();
  const code = await ask(["tinker", "ping"], cap.io);
  expect(code).toBe(4);
  expect(cap.err.join("")).toContain("agent 'tinker' not found");
});

test("daemon offline returns 3 with actionable message", async () => {
  scenario = "daemon_down";
  // Point at an unroutable port; no server started
  process.env.VOID_OS_BASE = "http://127.0.0.1:1";
  process.env.VOID_OS_TOKEN = "test-token";
  // Vault probe must succeed so we get 3 (daemon offline) not 5 (vault missing).
  // The repo root always exists on the test runner.
  process.env.VOID_OS_VAULT_ROOT = process.cwd();
  const cap = captureIo();
  const code = await ask(["tinker", "ping"], cap.io);
  delete process.env.VOID_OS_VAULT_ROOT;
  expect(code).toBe(3);
  expect(cap.err.join("")).toContain("daemon not running");
});

test("daemon offline + vault missing returns 5", async () => {
  scenario = "daemon_down";
  process.env.VOID_OS_BASE = "http://127.0.0.1:1";
  process.env.VOID_OS_TOKEN = "test-token";
  process.env.VOID_OS_VAULT_ROOT = "/definitely/does/not/exist/vos118-vault";
  const cap = captureIo();
  const code = await ask(["tinker", "ping"], cap.io);
  delete process.env.VOID_OS_VAULT_ROOT;
  expect(code).toBe(5);
  expect(cap.err.join("")).toContain("vault not configured");
});

test("ask_user during ask returns 6 with fail-fast suggestion and flushes buffered text", async () => {
  scenario = "ask_user";
  startServer();
  const cap = captureIo();
  const code = await ask(["tinker", "ping"], cap.io);
  expect(code).toBe(6);
  expect(cap.err.join("")).toContain("interactive mode");
  expect(cap.err.join("")).toContain("void-os chat tinker");
  // buffered text from before the ask_user frame must have been flushed
  expect(cap.out.join("")).toContain("before");
});

test("usage error (missing args) returns 2", async () => {
  scenario = "happy";
  startServer();
  const cap = captureIo();
  const code = await ask([], cap.io);
  expect(code).toBe(2);
  expect(cap.err.join("")).toContain("usage");
});

test("usage error (unknown flag) returns 2", async () => {
  scenario = "happy";
  startServer();
  const cap = captureIo();
  const code = await ask(["tinker", "ping", "--bogus"], cap.io);
  expect(code).toBe(2);
});

test("--help prints usage and returns 0", async () => {
  scenario = "happy";
  startServer();
  const cap = captureIo();
  const code = await ask(["--help"], cap.io);
  expect(code).toBe(0);
  expect(cap.out.join("") + cap.err.join("")).toContain("usage: void-os ask");
});
