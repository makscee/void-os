import { test, expect, beforeEach, afterEach } from "bun:test";
import { Readable } from "node:stream";
import chat from "../chat.ts";

type Frame = { event: string; data: unknown };

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
// Per-chat queue of SSE responses. Each entry is the frame list to emit for
// one consecutive /stream call. Allows scripting multi-message flows.
let frameQueues: Record<string, Frame[][]> = {};
let answersReceived: Array<{ tool_use_id: string; answer: string }> = [];
let cancelsReceived: string[] = [];

function sseBody(frames: Frame[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctl) {
      for (const f of frames) {
        ctl.enqueue(
          enc.encode(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`),
        );
      }
      ctl.close();
    },
  });
}

beforeEach(() => {
  answersReceived = [];
  cancelsReceived = [];
  frameQueues = {};
  let chatCounter = 0;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({
          ok: true,
          version: "test",
          vault_root: "/tmp/vault",
          uptime_s: 0,
          sessions: 0,
        });
      }
      if (url.pathname === "/agents" && req.method === "GET") {
        return Response.json({ agents: [{ name: "stub", description: "s" }] });
      }
      if (url.pathname === "/chats" && req.method === "POST") {
        chatCounter++;
        const id = `c${chatCounter}`;
        return Response.json({ id, title: "t", created_at: 0 });
      }
      const m1 = url.pathname.match(/^\/chat\/([^/]+)\/message$/);
      if (m1 && req.method === "POST") {
        return Response.json({ run_id: `r_${m1[1]}` });
      }
      const m2 = url.pathname.match(/^\/chat\/([^/]+)\/stream$/);
      if (m2 && req.method === "GET") {
        const id = m2[1];
        const frames = frameQueues[id]?.shift() ?? [];
        return new Response(sseBody(frames), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      const m3 = url.pathname.match(/^\/chat\/([^/]+)\/answer$/);
      if (m3 && req.method === "POST") {
        const body = (await req.json()) as { tool_use_id: string; answer: string };
        answersReceived.push(body);
        return Response.json({ ok: true });
      }
      const m4 = url.pathname.match(/^\/chat\/([^/]+)\/cancel$/);
      if (m4 && req.method === "POST") {
        cancelsReceived.push(m4[1]);
        return Response.json({ run_id: "r_x", status: "cancelled" });
      }
      return new Response("nf", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  process.env.VOID_OS_BASE = baseUrl;
  process.env.VOID_OS_TOKEN = "test-token";
});

afterEach(() => {
  server?.stop(true);
  delete process.env.VOID_OS_BASE;
  delete process.env.VOID_OS_TOKEN;
});

function withStdin(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + "\n"));
}

function collectStream() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      write(s: string) {
        chunks.push(s);
        return true;
      },
      isTTY: false,
    },
  };
}

test("usage: missing agent exits 2", async () => {
  const err = collectStream();
  const code = await chat([], {
    stdin: withStdin([]),
    stdout: collectStream().stream,
    stderr: err.stream,
  });
  expect(code).toBe(2);
  expect(err.chunks.join("")).toContain("usage");
});

test("usage: --help exits 0 and prints usage to stdout", async () => {
  const out = collectStream();
  const err = collectStream();
  const code = await chat(["--help"], {
    stdin: withStdin([]),
    stdout: out.stream,
    stderr: err.stream,
  });
  expect(code).toBe(0);
  expect(out.chunks.join("")).toContain("usage");
  expect(err.chunks.join("")).toBe("");
});

test("agent unknown returns 4", async () => {
  const err = collectStream();
  const code = await chat(["nosuch"], {
    stdin: withStdin([]),
    stdout: collectStream().stream,
    stderr: err.stream,
  });
  expect(code).toBe(4);
  expect(err.chunks.join("")).toContain("agent 'nosuch' not found");
});

test("daemon offline returns 3", async () => {
  process.env.VOID_OS_BASE = "http://127.0.0.1:1";
  const err = collectStream();
  const code = await chat(["stub"], {
    stdin: withStdin([]),
    stdout: collectStream().stream,
    stderr: err.stream,
  });
  expect(code).toBe(3);
  expect(err.chunks.join("")).toContain("daemon not running");
});

test("EOF on first prompt exits 0 cleanly", async () => {
  const out = collectStream();
  const code = await chat(["stub"], {
    stdin: withStdin([]),
    stdout: out.stream,
    stderr: collectStream().stream,
  });
  expect(code).toBe(0);
});

test("'/exit' command closes chat with 0", async () => {
  const code = await chat(["stub"], {
    stdin: withStdin(["/exit"]),
    stdout: collectStream().stream,
    stderr: collectStream().stream,
  });
  expect(code).toBe(0);
});

test("'exit' (no slash) closes chat with 0", async () => {
  const code = await chat(["stub"], {
    stdin: withStdin(["exit"]),
    stdout: collectStream().stream,
    stderr: collectStream().stream,
  });
  expect(code).toBe(0);
});

test("send → text → run_end prints model output, then EOF exits 0", async () => {
  frameQueues = {
    c1: [
      [
        { event: "text", data: { text: "hi back" } },
        { event: "run_end", data: {} },
      ],
    ],
  };
  const out = collectStream();
  const code = await chat(["stub"], {
    stdin: withStdin(["hello"]),
    stdout: out.stream,
    stderr: collectStream().stream,
  });
  expect(code).toBe(0);
  expect(out.chunks.join("")).toContain("hi back");
});

test("ask_user mid-stream — gate posts /answer and emits post-frames after answer", async () => {
  frameQueues = {
    c1: [
      [
        { event: "text", data: { text: "before " } },
        { event: "ask_user", data: { tool_use_id: "tu1", prompt: "your name?" } },
        { event: "text", data: { text: "nice to meet you eva" } },
        { event: "run_end", data: {} },
      ],
    ],
  };
  const out = collectStream();
  const code = await chat(["stub"], {
    stdin: withStdin(["hi", "eva"]),
    stdout: out.stream,
    stderr: collectStream().stream,
  });
  expect(code).toBe(0);
  expect(answersReceived).toEqual([{ tool_use_id: "tu1", answer: "eva" }]);
  const joined = out.chunks.join("");
  expect(joined).toContain("nice to meet you eva");
  // The post-ask_user text must appear in output AFTER the answer was posted.
  // (We can't easily test ordering vs the answer POST itself, but at minimum
  // the answer must have been received.)
});

test("tool_use + tool_result render between text frames", async () => {
  frameQueues = {
    c1: [
      [
        { event: "tool_use", data: { name: "vault.read", input: { path: "x.md" } } },
        { event: "tool_result", data: { ok: true, size: 1234 } },
        { event: "text", data: { text: "done" } },
        { event: "run_end", data: {} },
      ],
    ],
  };
  const out = collectStream();
  const code = await chat(["stub"], {
    stdin: withStdin(["go"]),
    stdout: out.stream,
    stderr: collectStream().stream,
  });
  expect(code).toBe(0);
  const joined = out.chunks.join("");
  expect(joined).toContain("vault.read");
  expect(joined).toContain("ok");
  expect(joined).toContain("done");
});

test("empty/whitespace input is re-prompted, then EOF exits 0", async () => {
  const code = await chat(["stub"], {
    stdin: withStdin(["", "   "]),
    stdout: collectStream().stream,
    stderr: collectStream().stream,
  });
  expect(code).toBe(0);
});

test("two consecutive messages each consume one /stream from the queue", async () => {
  frameQueues = {
    c1: [
      [{ event: "text", data: { text: "one" } }, { event: "run_end", data: {} }],
      [{ event: "text", data: { text: "two" } }, { event: "run_end", data: {} }],
    ],
  };
  const out = collectStream();
  const code = await chat(["stub"], {
    stdin: withStdin(["a", "b"]),
    stdout: out.stream,
    stderr: collectStream().stream,
  });
  expect(code).toBe(0);
  const joined = out.chunks.join("");
  expect(joined).toContain("one");
  expect(joined).toContain("two");
});

test("unknown flag exits 2", async () => {
  const err = collectStream();
  const code = await chat(["--bogus", "stub"], {
    stdin: withStdin([]),
    stdout: collectStream().stream,
    stderr: err.stream,
  });
  expect(code).toBe(2);
  expect(err.chunks.join("")).toContain("unknown flag");
});

test("missing daemon token surfaces NoTokenError message and exits 3", async () => {
  // Knock out env-based base/token and re-point HOME so resolveToken()
  // walks the FS path and throws NoTokenError (no ~/.void-os/token in
  // the swapped-in HOME).
  const realHome = process.env.HOME;
  delete process.env.VOID_OS_TOKEN;
  delete process.env.VOID_OS_BASE;
  process.env.HOME = "/tmp/void-os-test-no-token-" + Date.now();
  try {
    const err = collectStream();
    const code = await chat(["stub"], {
      stdin: withStdin([]),
      stdout: collectStream().stream,
      stderr: err.stream,
    });
    expect(code).toBe(3);
    // Must surface the actual NoTokenError message, not the generic
    // "daemon not running" fallback.
    expect(err.chunks.join("")).toContain("no daemon token");
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});

test("stream ends without run_end surfaces clear error and exits 3", async () => {
  // Daemon's SSE stream closes mid-run (no run_end, no error frame). This
  // means the daemon died or the connection dropped — REPL is unusable.
  frameQueues = {
    c1: [
      [
        { event: "text", data: { text: "partial..." } },
        // No run_end here — stream just ends.
      ],
    ],
  };
  const err = collectStream();
  const code = await chat(["stub"], {
    stdin: withStdin(["hello"]),
    stdout: collectStream().stream,
    stderr: err.stream,
  });
  expect(code).toBe(3);
  expect(err.chunks.join("")).toContain("stream ended unexpectedly");
});
