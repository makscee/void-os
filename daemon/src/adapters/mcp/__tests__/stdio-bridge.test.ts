import { describe, test, expect } from "bun:test";
import { validateBridgeEnv, stampMeta, forwardToDaemon } from "../stdio-bridge.ts";
import { runBridge, type BridgeTransport, type JsonRpcMessage } from "../stdio-bridge.ts";

type MemTransport = BridgeTransport & {
  push(msg: JsonRpcMessage): void;
  sent: JsonRpcMessage[];
  close(): void;
};

function makeMemTransport(): MemTransport {
  // VOS-112 T8 fix: onmessage / onclose are assignable properties (matches
  // the MCP SDK's StdioServerTransport contract), not setter methods.
  const sent: JsonRpcMessage[] = [];
  const t: MemTransport = {
    async send(m: JsonRpcMessage) { sent.push(m); },
    async start() { /* noop */ },
    async close() { t.onclose?.(); },
    push(m: JsonRpcMessage) { t.onmessage?.(m); },
    sent,
  };
  return t;
}

describe("runBridge", () => {
  const cfg = {
    daemonBase: "http://127.0.0.1:8729",
    agent: "maya",
    taskId: "T-1",
    contextId: "C-1",
    runId: "R-1",
  } as const;

  test("tools/call: stamps _meta then forwards; response returned via send()", async () => {
    const t = makeMemTransport();
    let captured: JsonRpcMessage | null = null;
    const stubFetch = async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as JsonRpcMessage;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }),
        { status: 200 },
      );
    };
    await runBridge(t, cfg, stubFetch as unknown as typeof fetch);
    t.push({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: { question: "q" } } });
    await new Promise((r) => setTimeout(r, 0));
    expect((captured!.params!._meta as { task_id: string }).task_id).toBe("T-1");
    expect(t.sent).toHaveLength(1);
    expect((t.sent[0]!.result as { content: { text: string }[] }).content[0]!.text).toBe("ok");
  });

  test("embedded newlines in tool result round-trip byte-for-byte (forge fix #2)", async () => {
    const t = makeMemTransport();
    const payload = "line-1\nline-2\nline-3 with \"quotes\" and a \\backslash";
    const stubFetch = async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: payload }] } }),
        { status: 200 },
      );
    await runBridge(t, cfg, stubFetch as unknown as typeof fetch);
    t.push({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "vault.read", arguments: { path: "x" } } });
    await new Promise((r) => setTimeout(r, 0));
    expect((t.sent[0]!.result as { content: { text: string }[] }).content[0]!.text).toBe(payload);
  });

  test("non-tools/call passthrough (initialize)", async () => {
    const t = makeMemTransport();
    let capturedUrl = "";
    const stubFetch = async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }),
        { status: 200 },
      );
    };
    await runBridge(t, cfg, stubFetch as unknown as typeof fetch);
    t.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedUrl).toBe("http://127.0.0.1:8729/mcp?agent=maya");
    expect((t.sent[0]!.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
  });
});

describe("validateBridgeEnv", () => {
  test("returns config when all required vars present", () => {
    const cfg = validateBridgeEnv({
      VOS_DAEMON_BASE: "http://127.0.0.1:8729",
      VOS_AGENT: "maya",
      VOS_TASK_ID: "T-1",
      VOS_CONTEXT_ID: "C-1",
      VOS_RUN_ID: "R-1",
    });
    expect(cfg).toEqual({
      daemonBase: "http://127.0.0.1:8729",
      agent: "maya",
      taskId: "T-1",
      contextId: "C-1",
      runId: "R-1",
    });
  });

  test("defaults VOS_CONTEXT_ID to VOS_TASK_ID when absent", () => {
    const cfg = validateBridgeEnv({
      VOS_DAEMON_BASE: "http://127.0.0.1:8729",
      VOS_AGENT: "maya",
      VOS_TASK_ID: "T-1",
    });
    expect(cfg.contextId).toBe("T-1");
    expect(cfg.runId).toBeNull();
  });

  test("throws on missing required var", () => {
    expect(() =>
      validateBridgeEnv({ VOS_AGENT: "maya", VOS_TASK_ID: "T-1" }),
    ).toThrow(/VOS_DAEMON_BASE/);
  });
});

describe("stampMeta", () => {
  const cfg = {
    daemonBase: "http://127.0.0.1:8729",
    agent: "maya",
    taskId: "T-1",
    contextId: "C-1",
    runId: "R-1",
  } as const;

  test("stamps task_id / context_id / run_id on tools/call", () => {
    const out = stampMeta(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: {} } },
      cfg,
    );
    expect(out.params!._meta).toEqual({
      task_id: "T-1",
      context_id: "C-1",
      run_id: "R-1",
    });
  });

  test("omits run_id when null", () => {
    const out = stampMeta(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } },
      { ...cfg, runId: null },
    );
    expect("run_id" in (out.params!._meta as object)).toBe(false);
  });

  test("preserves model-supplied _meta fields the daemon does not stamp", () => {
    const out = stampMeta(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "ask_user", arguments: {}, _meta: { _vos_tool_use_id: "tu-123" } },
      },
      cfg,
    );
    expect((out.params!._meta as Record<string, unknown>)._vos_tool_use_id).toBe("tu-123");
    expect((out.params!._meta as Record<string, unknown>).task_id).toBe("T-1");
  });

  test("daemon-stamped fields override model-supplied task_id", () => {
    const out = stampMeta(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "ask_user", arguments: {}, _meta: { task_id: "SPOOF" } },
      },
      cfg,
    );
    expect((out.params!._meta as Record<string, unknown>).task_id).toBe("T-1");
  });

  test("passthrough on initialize / tools/list / notifications", () => {
    const inputs: JsonRpcMessage[] = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
    for (const m of inputs) {
      expect(stampMeta(m, cfg)).toEqual(m);
    }
  });
});

describe("forwardToDaemon", () => {
  const cfg = {
    daemonBase: "http://127.0.0.1:8729",
    agent: "maya",
    taskId: "T-1",
    contextId: "C-1",
    runId: "R-1",
  } as const;

  test("POSTs the stamped envelope to /mcp?agent=<agent> and returns the body", async () => {
    let captured: { url: string; body: string } | null = null;
    const stubFetch = async (url: string, init: RequestInit) => {
      captured = { url, body: init.body as string };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const out = await forwardToDaemon(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } },
      cfg,
      stubFetch as unknown as typeof fetch,
    );
    expect(captured!.url).toBe("http://127.0.0.1:8729/mcp?agent=maya");
    expect(JSON.parse(captured!.body).method).toBe("tools/call");
    expect(out).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  test("network failure → JSON-RPC -32603 with BRIDGE_UPSTREAM_FAIL", async () => {
    const stubFetch = async () => {
      throw new TypeError("connection refused");
    };
    const out = await forwardToDaemon(
      { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "x", arguments: {} } },
      cfg,
      stubFetch as unknown as typeof fetch,
    );
    expect(out.id).toBe(42);
    expect(out.error?.code).toBe(-32603);
    expect((out.error?.data as { kind: string }).kind).toBe("BRIDGE_UPSTREAM_FAIL");
  });

  test("non-2xx HTTP → JSON-RPC -32603 with BRIDGE_UPSTREAM_FAIL", async () => {
    const stubFetch = async () =>
      new Response("upstream down", { status: 503 });
    const out = await forwardToDaemon(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x", arguments: {} } },
      cfg,
      stubFetch as unknown as typeof fetch,
    );
    expect(out.error?.code).toBe(-32603);
    expect((out.error?.data as { status: number }).status).toBe(503);
  });
});
