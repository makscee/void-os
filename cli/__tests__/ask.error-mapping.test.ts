/**
 * Error-mapping tests for `cli/ask.ts`: race-case where daemon returns 404
 * E_AGENT_NOT_FOUND on POST /chats (agent disappeared between agents.list and
 * chat.create — vault hot-reload / daemon restart window).
 *
 * Uses the same env-var + Bun.serve pattern as ask.test.ts.
 */

import { test, expect, afterEach } from "bun:test";
import ask from "../ask.ts";

let server: ReturnType<typeof Bun.serve> | undefined;

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

afterEach(() => {
  if (server) {
    server.stop();
    server = undefined;
  }
  delete process.env.VOID_OS_BASE;
  delete process.env.VOID_OS_TOKEN;
});

test("daemon returns 404 E_AGENT_NOT_FOUND on chat.create → exit 4 + stderr mentions agent name and 'not found'", async () => {
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
      if (url.pathname === "/agents" && req.method === "GET") {
        return Response.json({
          agents: [{ name: "tinker", path: "/x/tinker", description: "test agent" }],
        });
      }
      if (url.pathname === "/chats" && req.method === "POST") {
        return Response.json(
          { error: "E_AGENT_NOT_FOUND", message: "agent 'tinker' not found" },
          { status: 404 },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  process.env.VOID_OS_BASE = `http://127.0.0.1:${server.port}`;
  process.env.VOID_OS_TOKEN = "test-token";
  // Ensure vault probe doesn't fire (daemon is reachable; this won't be hit)
  process.env.VOID_OS_VAULT_ROOT = process.cwd();

  const cap = captureIo();
  const code = await ask(["tinker", "ping"], cap.io);

  delete process.env.VOID_OS_VAULT_ROOT;

  expect(code).toBe(4);
  const stderrText = cap.err.join("");
  expect(stderrText).toContain("tinker");
  expect(stderrText).toContain("not found");
});
