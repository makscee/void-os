# VOS-112 stdio MCP bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spawned production CC subprocesses reach `vos_ask_user` / `vos_ask_agent` with the correct `_meta.task_id`, by routing their MCP traffic through a per-spawn stdio bridge that stamps runtime ids from env onto every `tools/call`.

**Architecture:** New file `daemon/src/adapters/mcp/stdio-bridge.ts` is a stateless `bun`-launched proxy. CC launches it as a stdio MCP server via per-spawn `mcp.json`; the daemon writes the bridge path + `VOS_TASK_ID` / `VOS_CONTEXT_ID` / `VOS_RUN_ID` / `VOS_AGENT` / `VOS_DAEMON_BASE` into that file's `env` block. The bridge uses the official `StdioServerTransport` (no hand-rolled framing), stamps `params._meta` on `tools/call`, and POSTs to the daemon's existing HTTP `/mcp?agent=<name>`. Tool handlers and the HTTP route are unchanged; the fake provider keeps its direct-HTTP path.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/sdk` 1.20.x, Hono (daemon HTTP). Tests: `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-17-vos-112-stdio-mcp-bridge-design.md`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `daemon/src/adapters/mcp/stdio-bridge.ts` | new | Bridge entrypoint. SDK stdio transport in, env stamping, HTTP fetch out. ~80 LOC. |
| `daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts` | new | Unit tests for the bridge (env stamping, passthrough, error mapping, payload integrity). |
| `daemon/src/providers/claude-code/spawn-settings.ts` | edit | mcp.json shape: stdio command/args/env instead of HTTP url. Resolve `BRIDGE_PATH` + `BUN_PATH` module-init-once. |
| `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts` | edit | Flip URL-shape assertions to stdio-shape assertions. |
| `daemon/src/providers/claude-code/index.ts` | edit | `CcSpawnRequest` gains `taskId`, `contextId`, `runId`; threaded into `buildSpawnSettings`. |
| `daemon/src/providers/claude-code/provider.ts` | edit | `CcIter.spawn` signature gains `task_id`. |
| `daemon/src/providers/claude-code/spawner.ts` | edit | `makeCcSpawnerIter.spawn` signature gains `task_id`; forwards to `cc.spawn`. |
| `daemon/src/providers/claude-code/__tests__/cc-spawner-loader.test.ts` | edit | URL fixture → stdio fixture. |
| `daemon/test/integration/stdio-bridge-e2e.test.ts` | new | Real bridge subprocess vs running daemon. Covers AC-1, AC-2, AC-4, AC-6, AC-5. |

Daemon tool handlers (`ask-user.ts`, `ask-agent.ts`, `vault-read.ts`), `mcp/index.ts` HTTP route, and the fake provider are NOT touched.

---

### Task 1: Bridge — fail-fast env validation

**Files:**
- Create: `daemon/src/adapters/mcp/stdio-bridge.ts`
- Test: `daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts
import { describe, test, expect } from "bun:test";
import { validateBridgeEnv } from "../stdio-bridge.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/__tests__/stdio-bridge.test.ts`
Expected: FAIL — module `../stdio-bridge.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// daemon/src/adapters/mcp/stdio-bridge.ts
// VOS-112: per-spawn stdio MCP proxy. Reads runtime ids from env, stamps
// `params._meta` on every `tools/call`, forwards JSON-RPC frames to the
// daemon's HTTP /mcp route. Launched by CC as the void-os MCP server.

export interface BridgeConfig {
  daemonBase: string;
  agent: string;
  taskId: string;
  contextId: string;
  runId: string | null;
}

export function validateBridgeEnv(env: Record<string, string | undefined>): BridgeConfig {
  const required = ["VOS_DAEMON_BASE", "VOS_AGENT", "VOS_TASK_ID"] as const;
  for (const k of required) {
    if (!env[k] || env[k]!.length === 0) {
      throw new Error(`missing required env: ${k}`);
    }
  }
  return {
    daemonBase: env.VOS_DAEMON_BASE!,
    agent:     env.VOS_AGENT!,
    taskId:    env.VOS_TASK_ID!,
    contextId: env.VOS_CONTEXT_ID && env.VOS_CONTEXT_ID.length > 0
      ? env.VOS_CONTEXT_ID
      : env.VOS_TASK_ID!,
    runId:     env.VOS_RUN_ID && env.VOS_RUN_ID.length > 0 ? env.VOS_RUN_ID : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/__tests__/stdio-bridge.test.ts`
Expected: PASS — three tests green.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add daemon/src/adapters/mcp/stdio-bridge.ts \
        daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts
git commit -m "feat(VOS-112): stdio-bridge env validator (T1)"
```

---

### Task 2: Bridge — `_meta` stamping on `tools/call`

**Files:**
- Modify: `daemon/src/adapters/mcp/stdio-bridge.ts`
- Test: `daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { stampMeta } from "../stdio-bridge.ts";

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
    expect(out.params._meta).toEqual({
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
    expect("run_id" in (out.params._meta as object)).toBe(false);
  });

  test("preserves model-supplied _meta fields the daemon does not stamp", () => {
    const out = stampMeta(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "ask_user", arguments: {}, _meta: { _vos_tool_use_id: "tu-123" } },
      },
      cfg,
    );
    expect((out.params._meta as Record<string, unknown>)._vos_tool_use_id).toBe("tu-123");
    expect((out.params._meta as Record<string, unknown>).task_id).toBe("T-1");
  });

  test("daemon-stamped fields override model-supplied task_id", () => {
    const out = stampMeta(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "ask_user", arguments: {}, _meta: { task_id: "SPOOF" } },
      },
      cfg,
    );
    expect((out.params._meta as Record<string, unknown>).task_id).toBe("T-1");
  });

  test("passthrough on initialize / tools/list / notifications", () => {
    const inputs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
    for (const m of inputs) {
      expect(stampMeta(m, cfg)).toEqual(m);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/__tests__/stdio-bridge.test.ts`
Expected: FAIL — `stampMeta` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `stdio-bridge.ts`:

```ts
// JSON-RPC envelope shape (loose, intentionally — bridge is a proxy).
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function stampMeta(msg: JsonRpcMessage, cfg: BridgeConfig): JsonRpcMessage {
  if (msg.method !== "tools/call" || !msg.params) return msg;
  // Spread order: model _meta first, daemon-controlled fields override.
  const stamped: Record<string, unknown> = {
    ...(msg.params._meta ?? {}),
    task_id: cfg.taskId,
    context_id: cfg.contextId,
  };
  if (cfg.runId !== null) stamped.run_id = cfg.runId;
  return { ...msg, params: { ...msg.params, _meta: stamped } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/__tests__/stdio-bridge.test.ts`
Expected: PASS — all `stampMeta` tests green plus the three from Task 1.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add daemon/src/adapters/mcp/stdio-bridge.ts \
        daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts
git commit -m "feat(VOS-112): stdio-bridge _meta stamping (T2)"
```

---

### Task 3: Bridge — HTTP forward + error mapping (no transport yet)

**Files:**
- Modify: `daemon/src/adapters/mcp/stdio-bridge.ts`
- Test: `daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
import { forwardToDaemon } from "../stdio-bridge.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/__tests__/stdio-bridge.test.ts`
Expected: FAIL — `forwardToDaemon` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `stdio-bridge.ts`:

```ts
export async function forwardToDaemon(
  msg: JsonRpcMessage,
  cfg: BridgeConfig,
  fetchFn: typeof fetch = fetch,
): Promise<JsonRpcMessage> {
  const url = `${cfg.daemonBase}/mcp?agent=${encodeURIComponent(cfg.agent)}`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      // Accept BOTH application/json and text/event-stream: the daemon's
      // `StreamableHTTPServerTransport` returns 406 if `accept` does not
      // include text/event-stream, and only returns a single-envelope JSON
      // body (rather than SSE) when constructed with enableJsonResponse:true.
      // T7a flips that flag on the daemon route. With the flag set the
      // response is a single JSON envelope and the .json() parse below works.
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32603,
        message: "bridge upstream fetch failed",
        data: { kind: "BRIDGE_UPSTREAM_FAIL", message },
      },
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32603,
        message: `bridge upstream HTTP ${res.status}`,
        data: { kind: "BRIDGE_UPSTREAM_FAIL", status: res.status, body: body.slice(0, 500) },
      },
    };
  }
  return (await res.json()) as JsonRpcMessage;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/__tests__/stdio-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add daemon/src/adapters/mcp/stdio-bridge.ts \
        daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts
git commit -m "feat(VOS-112): stdio-bridge HTTP forward + error mapping (T3)"
```

---

### Task 4: Bridge — wire to SDK `StdioServerTransport` + `main()`

**Files:**
- Modify: `daemon/src/adapters/mcp/stdio-bridge.ts`
- Test: `daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts` (append)

The bridge must use the official `@modelcontextprotocol/sdk` stdio transport so framing (buffering across read chunks, JSON-RPC envelope boundaries) is handled by the SDK rather than hand-rolled. We export a `runBridge(transport, cfg, fetchFn)` function so the unit test drives it with an in-memory transport pair; the executable `main()` wires the SDK's real `StdioServerTransport`.

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { runBridge, type BridgeTransport } from "../stdio-bridge.ts";

// In-memory transport that satisfies the SDK's onmessage/send/onclose surface.
function makeMemTransport(): BridgeTransport & {
  push(msg: JsonRpcMessage): void;
  sent: JsonRpcMessage[];
  close(): void;
} {
  let handler: ((m: JsonRpcMessage) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const sent: JsonRpcMessage[] = [];
  return {
    onmessage(h) { handler = h; },
    onclose(h)   { closeHandler = h; },
    async send(m) { sent.push(m); },
    async start() { /* noop */ },
    async close() { closeHandler?.(); },
    push(m)   { handler?.(m); },
    sent,
    close()   { closeHandler?.(); },
  };
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
    // Yield so the awaited fetch + send complete.
    await new Promise((r) => setTimeout(r, 0));
    expect((captured!.params!._meta as { task_id: string }).task_id).toBe("T-1");
    expect(t.sent).toHaveLength(1);
    expect((t.sent[0].result as { content: { text: string }[] }).content[0].text).toBe("ok");
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
    expect((t.sent[0].result as { content: { text: string }[] }).content[0].text).toBe(payload);
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
    expect((t.sent[0].result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/__tests__/stdio-bridge.test.ts`
Expected: FAIL — `runBridge` / `BridgeTransport` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `stdio-bridge.ts`:

```ts
// Minimal surface the bridge uses from any stdio transport. Matches the
// portion of `@modelcontextprotocol/sdk/server/stdio.js` we depend on so
// unit tests can drive an in-memory pair. The real transport is wired in
// `main()` below.
export interface BridgeTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  send(msg: JsonRpcMessage): Promise<void>;
  onmessage(handler: (msg: JsonRpcMessage) => void): void;
  onclose(handler: () => void): void;
}

export async function runBridge(
  transport: BridgeTransport,
  cfg: BridgeConfig,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  transport.onmessage((msg) => {
    void (async () => {
      const stamped = stampMeta(msg, cfg);
      const reply = await forwardToDaemon(stamped, cfg, fetchFn);
      await transport.send(reply);
    })();
  });
  transport.onclose(() => { /* SDK transport will end the process via main(). */ });
  await transport.start();
}

// CLI entrypoint: launched by CC via mcp.json command/args. Wires the real
// SDK stdio transport; on env failure, prints a JSON-RPC error envelope to
// stdout and exits 1 (CC surfaces as `mcp_servers[void-os].status="failed"`).
async function main(): Promise<void> {
  let cfg: BridgeConfig;
  try {
    cfg = validateBridgeEnv(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: null,
      error: { code: -32603, message, data: { kind: "BRIDGE_CONFIG_FAIL" } },
    }) + "\n");
    process.exit(1);
  }
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport() as unknown as BridgeTransport;
  // Exit cleanly when the parent CC closes its stdin pipe.
  process.stdin.on("close", () => process.exit(0));
  await runBridge(transport, cfg);
}

// Bun runs the file as the main module when launched via `bun stdio-bridge.ts`.
// `import.meta.main` is the Bun-idiomatic check (equivalent to Node's
// `require.main === module`). Wrapped so the file remains importable in tests
// without side effects.
if (import.meta.main) {
  void main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os/daemon && bun test src/adapters/mcp/__tests__/stdio-bridge.test.ts`
Expected: PASS — all 9-ish bridge unit tests green, including the embedded-newline round-trip.

- [ ] **Step 5: Smoke-run the executable**

Run: `cd workspace/void-os/daemon && bun src/adapters/mcp/stdio-bridge.ts < /dev/null; echo "exit=$?"`
Expected: stdout contains a JSON envelope mentioning `VOS_DAEMON_BASE`; `exit=1`. Confirms AC-6 fail-fast.

- [ ] **Step 6: Commit**

```bash
cd workspace/void-os
git add daemon/src/adapters/mcp/stdio-bridge.ts \
        daemon/src/adapters/mcp/__tests__/stdio-bridge.test.ts
git commit -m "feat(VOS-112): stdio-bridge SDK transport + main() (T4)"
```

---

### Task 5: spawn-settings — resolve `BRIDGE_PATH` + `BUN_PATH`, rewrite mcp.json shape

**Files:**
- Modify: `daemon/src/providers/claude-code/spawn-settings.ts`

`BuildSpawnSettingsArgs` gains three required string fields (`taskId`, `contextId`, `runId`). The mcp.json body switches from `{type:"http", url}` to `{type:"stdio", command, args, env}`. Bridge path is module-init-once with an `existsSync` boot assertion so a wrong path fails at daemon import, not at the first spawn.

- [ ] **Step 1: Write the failing test**

Add a fresh test in `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts` (or replace the existing URL-shape test):

```ts
test("mcp.json now uses stdio transport with env-stamped runtime ids", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos112-"));
  const built = buildSpawnSettings({
    agentName: "maya",
    scopes: { readPaths: [], writePaths: [] },
    systemDeny: [],
    vaultRoot: "/vault",
    daemonBase: "http://127.0.0.1:8729",
    runId: "R-1",
    taskId: "T-1",
    contextId: "C-1",
    settingsDir: tmp,
    hookScriptPath: "/hook.ts",
  });
  const mcp = JSON.parse(readFileSync(built.mcpConfigPath, "utf8")) as {
    mcpServers: { "void-os": { type: string; command: string; args: string[]; env: Record<string, string> } };
  };
  const entry = mcp.mcpServers["void-os"];
  expect(entry.type).toBe("stdio");
  expect(entry.command).toBe(process.execPath);
  expect(entry.args).toHaveLength(1);
  expect(entry.args[0]).toMatch(/stdio-bridge\.ts$/);
  expect(entry.env.VOS_DAEMON_BASE).toBe("http://127.0.0.1:8729");
  expect(entry.env.VOS_AGENT).toBe("maya");
  expect(entry.env.VOS_TASK_ID).toBe("T-1");
  expect(entry.env.VOS_CONTEXT_ID).toBe("C-1");
  expect(entry.env.VOS_RUN_ID).toBe("R-1");
  // Belt-and-suspenders: URL shape is gone.
  expect((entry as Record<string, unknown>).url).toBeUndefined();
});
```

Adjust imports at the top of the test file as needed (`mkdtempSync`, `readFileSync` from `node:fs`, `tmpdir` from `node:os`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os/daemon && bun test src/providers/claude-code/__tests__/spawn-settings.test.ts`
Expected: FAIL — `taskId` / `contextId` not accepted by `BuildSpawnSettingsArgs`, mcp.json still has `url`.

- [ ] **Step 3: Edit `spawn-settings.ts`**

At the top, replace the imports + add module-init resolution:

```ts
// daemon/src/providers/claude-code/spawn-settings.ts
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// VOS-112: stdio bridge entrypoint shipped with the daemon. The daemon runs
// from source (ADR-0003), so this path is the source file itself. Resolved
// once at module init; an existsSync assertion makes a misconfigured tree
// fail at daemon boot rather than at first CC spawn.
//
// From daemon/src/providers/claude-code/spawn-settings.ts →
// daemon/src/adapters/mcp/stdio-bridge.ts.
const BRIDGE_PATH = resolve(
  import.meta.dir, "..", "..", "adapters", "mcp", "stdio-bridge.ts",
);
if (!existsSync(BRIDGE_PATH)) {
  throw new Error(`VOS-112 stdio-bridge.ts not found at ${BRIDGE_PATH}`);
}

// Absolute bun binary path — survives systemd / launchd that strip the user
// shell PATH. `process.execPath` is the bun running the daemon itself, so a
// spawned CC subprocess inherits the daemon's exact runtime.
//
// Footgun: this assumes the daemon runs from source (ADR-0003) and is never
// shipped as a single-file `bun build --compile` binary. If it ever is,
// process.execPath becomes the compiled daemon binary, not `bun`, and passing
// it a `.ts` source path re-launches the daemon with a stray arg instead of
// the bridge — production CC tool calls all fail. The VOS_BUN_PATH env
// override lets a packaged deploy pin the bridge to a real `bun` binary
// without code changes; default keeps dev-from-source ergonomics.
const BUN_PATH = process.env.VOS_BUN_PATH ?? process.execPath;
```

Extend `BuildSpawnSettingsArgs`:

```ts
export interface BuildSpawnSettingsArgs {
  agentName: string;
  scopes: { readPaths: string[]; writePaths: string[] };
  systemDeny: string[];
  vaultRoot: string;
  daemonBase: string;
  runId: string;
  // VOS-112: per-spawn runtime ids consumed by the stdio bridge via env.
  // `contextId` defaults are the orchestrator's concern; bridge treats
  // missing VOS_CONTEXT_ID as equal to VOS_TASK_ID.
  taskId: string;
  contextId: string;
  settingsDir: string;
  hookScriptPath: string;
}
```

Replace the `mcp = { ... }` block (the one around lines 98–110) with:

```ts
  // VOS-112: stdio MCP transport. Per-spawn env carries runtime ids that
  // the daemon-side handlers read off `extra._meta` (ADR-0002). Stable
  // command+args across runs keeps CC's prompt-cache hot; only env varies.
  const mcp = {
    mcpServers: {
      "void-os": {
        type: "stdio",
        command: BUN_PATH,
        args: [BRIDGE_PATH],
        env: {
          VOS_DAEMON_BASE: args.daemonBase,
          VOS_AGENT:       args.agentName,
          VOS_TASK_ID:     args.taskId,
          VOS_CONTEXT_ID:  args.contextId,
          ...(args.runId ? { VOS_RUN_ID: args.runId } : {}),
        },
      },
    },
  };
```

Leave the rest of `buildSpawnSettings` (`settings` block, hook env, returned `env` object) intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os/daemon && bun test src/providers/claude-code/__tests__/spawn-settings.test.ts`
Expected: PASS — stdio-shape test green; any other tests in this file may need their input args updated to pass the new `taskId` / `contextId` fields (do so inline — set them to placeholder strings like `"T-test"` / `"C-test"`).

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add daemon/src/providers/claude-code/spawn-settings.ts \
        daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts
git commit -m "feat(VOS-112): mcp.json stdio shape + BRIDGE_PATH/BUN_PATH init (T5)"
```

---

### Task 6: Thread `taskId` / `contextId` through `CcIter` and `makeCcSpawnerIter`

**Files:**
- Modify: `daemon/src/providers/claude-code/provider.ts`
- Modify: `daemon/src/providers/claude-code/spawner.ts`

`ProviderSpawnRequest` already carries `taskId` and `contextId` (orchestrator sets them at line 491–492 of `chat/orchestrator.ts`). We thread them down the `CcIter.spawn` → `cc.spawn` chain so the existing `CcSpawnRequest` in `index.ts` can pass them into `buildSpawnSettings`.

- [ ] **Step 1: Edit `CcIter` in `provider.ts`**

Replace the `CcIter.spawn` signature (around line 19–26):

```ts
export interface CcIter {
  spawn(args: {
    chat_id: string;
    task_id: string;          // VOS-112
    resume: string | null;
    prompt: string;
  }): AsyncIterable<RawCcEvent>;
  cancel?(runId: string): Promise<boolean>;
}
```

Update the call site in `makeClaudeCodeProvider` (around line 52):

```ts
      const raw = deps.iter.spawn({
        chat_id: req.contextId,
        task_id: req.taskId,    // VOS-112
        resume: req.resumeFrom ?? null,
        prompt: req.prompt,
      });
```

- [ ] **Step 2: Edit `makeCcSpawnerIter` in `spawner.ts`**

Update both the public return type (around line 65–67) and the inner `iterate` signature + `deps.cc.spawn` call site:

```ts
export function makeCcSpawnerIter(deps: SpawnerIterDeps): {
  spawn(args: { chat_id: string; task_id: string; resume: string | null; prompt: string }): AsyncIterable<ProviderEvent>;
  cancel?(runId: string): Promise<boolean>;
} {
  // ... existing activeProcs map ...
  return {
    spawn(args) {
      return iterate(deps, args, activeProcs);
    },
    // ... existing cancel ...
  };
}

async function* iterate(
  deps: SpawnerIterDeps,
  args: { chat_id: string; task_id: string; resume: string | null; prompt: string },
  activeProcs: Map<string, { kill: (opts?: KillOpts) => Promise<void> }>,
): AsyncGenerator<ProviderEvent, void, void> {
  // ... unchanged until the deps.cc.spawn call (around line 166) ...
  const proc = await deps.cc.spawn({
    prompt: args.prompt,
    agent: deps.agent,
    cwd: deps.cwd,
    chatId: args.chat_id,
    taskId: args.task_id,      // VOS-112
    contextId: args.chat_id,   // VOS-112: orchestrator already folds chat→context
    resumeFrom: args.resume ?? undefined,
  });
  // ... rest unchanged ...
}
```

- [ ] **Step 3: Edit `CcSpawnRequest` in `index.ts`**

Extend `CcSpawnRequest` (around line 22–37):

```ts
export interface CcSpawnRequest {
  prompt: string;
  agent: string;
  cwd: string;
  chatId?: string;
  // VOS-112: per-spawn runtime ids forwarded into mcp.json env so the stdio
  // bridge can stamp `_meta.task_id` on every `tools/call` POST to /mcp.
  taskId: string;
  contextId: string;
  kind?: "chat" | "skill" | "worker";
  resumeFrom?: string;
  outputTimeoutMs?: number;
  toolTimeoutMs?: number;
  firstEventTimeoutMs?: number;
  settings?: unknown;
}
```

In `createCcSpawner.spawn(req)`, find the `buildSpawnSettings(...)` call (around line 227) and pass the new fields:

```ts
        const built = buildSpawnSettings({
          agentName: req.agent,
          scopes,
          systemDeny: expandedDeny,
          vaultRoot: req.cwd,
          daemonBase: deps.daemonBase,
          runId,
          taskId:    req.taskId,     // VOS-112
          contextId: req.contextId,  // VOS-112
          settingsDir: deps.tracesDir,
          hookScriptPath: deps.hookScriptPath,
        });
```

- [ ] **Step 4: Run typecheck + relevant unit suite**

Run: `cd workspace/void-os/daemon && bun tsc --noEmit`
Expected: no type errors.
Run: `cd workspace/void-os/daemon && bun test src/providers/claude-code/__tests__/`
Expected: all suites green. The `cc-spawner-loader.test.ts` will surface as the only failure if it still asserts the URL shape — handle in Task 7.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add daemon/src/providers/claude-code/provider.ts \
        daemon/src/providers/claude-code/spawner.ts \
        daemon/src/providers/claude-code/index.ts
git commit -m "feat(VOS-112): thread taskId/contextId through CcIter chain (T6)"
```

---

### Task 7: Fix `cc-spawner-loader.test.ts` URL-shape fixture

**Files:**
- Modify: `daemon/src/providers/claude-code/__tests__/cc-spawner-loader.test.ts`

- [ ] **Step 1: Identify the URL fixture**

Run: `cd workspace/void-os/daemon && grep -n "agent=\|type.*http" src/providers/claude-code/__tests__/cc-spawner-loader.test.ts`
Expected: one or two lines asserting the old `?agent=` URL shape.

- [ ] **Step 2: Replace with stdio-shape assertion**

Wherever the old assertion stood, replace it with the stdio equivalent. If the test was asserting "URL contains `?agent=maya`", swap to:

```ts
const mcp = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
  mcpServers: { "void-os": { type: string; env: Record<string, string> } };
};
expect(mcp.mcpServers["void-os"].type).toBe("stdio");
expect(mcp.mcpServers["void-os"].env.VOS_AGENT).toBe("maya");
```

If the test constructs a `CcSpawnRequest`, also add `taskId: "T-test"` and `contextId: "C-test"` to the fixture so it typechecks against the extended interface.

- [ ] **Step 3: Run test to verify it passes**

Run: `cd workspace/void-os/daemon && bun test src/providers/claude-code/__tests__/cc-spawner-loader.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd workspace/void-os
git add daemon/src/providers/claude-code/__tests__/cc-spawner-loader.test.ts
git commit -m "test(VOS-112): cc-spawner-loader URL fixture → stdio (T7)"
```

---

### Task 7a: Enable single-JSON responses on the daemon `/mcp` route (interop with bridge)

**Files:**
- Modify: `daemon/src/adapters/mcp/index.ts`
- Modify: `daemon/src/adapters/mcp/__tests__/` (any HTTP-shape test, if one assumes SSE)

The MCP TypeScript SDK's `StreamableHTTPServerTransport` defaults to SSE responses for JSON-RPC requests. The bridge's `forwardToDaemon` POSTs a single JSON-RPC envelope and parses the response with `.json()`. Without `enableJsonResponse: true`, the route returns `text/event-stream` and the bridge throws on parse — `vos_ask_user` never works in real CC. The fake provider currently works because it ignores the SSE framing (its assertions only check status); flipping the flag is benign for fake.

- [ ] **Step 1: Edit the transport construction**

In `daemon/src/adapters/mcp/index.ts` around line 168:

```ts
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,  // VOS-112: return single JSON envelope so the stdio bridge can parse with .json().
    });
```

- [ ] **Step 2: Verify fake provider e2e still green**

Run: `cd workspace/void-os/daemon && bun test src/providers/fake/__tests__/`
Expected: PASS — the fake provider sends `Accept: application/json, text/event-stream` already (per its existing code path) and tolerates either framing; flipping the flag changes the wire to JSON, which the fake test treats as a body that contains the JSON-RPC envelope.

If a test was hard-coded to read SSE framing, update it to parse JSON directly.

- [ ] **Step 3: Commit**

```bash
cd workspace/void-os
git add daemon/src/adapters/mcp/index.ts
git commit -m "feat(VOS-112): /mcp returns single JSON envelope (T7a)"
```

---

### Task 8: Integration — real bridge subprocess vs daemon (AC-1, AC-2, AC-6)

**Files:**
- Create: `daemon/test/integration/stdio-bridge-e2e.test.ts`

This is a real integration test: it boots the daemon HTTP app, spawns a real `bun stdio-bridge.ts` subprocess with controlled env, performs an `initialize` and a `tools/call ask_user`, and asserts the daemon handler observed `_meta.task_id` equal to the env value. Use the existing test-app builder so the test owns the bridge lifecycle.

- [ ] **Step 1: Locate or build the daemon-integration scaffold**

Run: `cd workspace/void-os/daemon && grep -rn "buildApp\|listen\|new Hono" test/integration src/app.ts | head -10`
Reuse any existing test-app builder. If none, create `daemon/test/integration/helpers/start-test-daemon.ts` returning this exact contract:

```ts
export interface TestDaemon {
  port: number;
  db: Database;
  bus: EventBus;
  bridge: AskUserBridge;
  // Resolves when AskUserBridge.open() is called for `taskId` and persists
  // the pending row. Subscribes to the bus for `task.state_changed` events
  // where state="TASK_STATE_INPUT_REQUIRED" and matches by taskId, then
  // reads the toolUseId off the latest ask_user_pending row.
  // VOS-112: helpers below live on TestDaemon (NOT on AskUserBridge, which is
  // production code and must stay free of test-only methods).
  waitForPending(taskId: string, timeoutMs: number): Promise<{ taskId: string; contextId: string; toolUseId: string }>;
  resolveAnswer(toolUseId: string, answer: string): void;
  close(): Promise<void>;
}
export interface StartTestDaemonOpts {
  // VOS-112 AC-2: spy injected at construction so mountMcp closes over it.
  // A post-construction setter would not affect the already-mounted /mcp
  // route — the route captured `deps` at boot. Per test, instantiate a new
  // daemon with the spy pre-wired.
  dispatchChildTask?: (childTaskId: string, args: { agentName: string; message: string; systemMessage?: string }) => Promise<void>;
}
export function startTestDaemon(opts?: StartTestDaemonOpts): Promise<TestDaemon>;
```

Implementation outline (≈80 LOC): boot an in-memory SQLite, run migrations, construct EventBus + AskUserBridge, mount `/mcp` and `/chat/:id/answer` against a Hono app, `serve()` on port 0, expose the actual port. `waitForPending` listens on the bus + queries `SELECT tool_use_id FROM ask_user_pending WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`. `resolveAnswer` calls `bridge.resolve({taskId: <derived>, toolUseId, answer})`.

- [ ] **Step 2: Write the test**

```ts
// daemon/test/integration/stdio-bridge-e2e.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Replace this import with the project's actual test-app builder (see Step 1).
// The builder must return { fetch, port, db, bus, bridge, askUserHandlerSpy }.
import { startTestDaemon } from "./helpers/start-test-daemon.ts";

const BRIDGE = resolve(__dirname, "../../src/adapters/mcp/stdio-bridge.ts");

async function ping(child: ReturnType<typeof spawn>, msg: object): Promise<unknown> {
  child.stdin!.write(JSON.stringify(msg) + "\n");
  return await new Promise((res, rej) => {
    const onData = (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim().split("\n").pop()!;
      child.stdout!.off("data", onData);
      res(JSON.parse(line));
    };
    child.stdout!.on("data", onData);
    setTimeout(() => rej(new Error("bridge response timeout")), 5_000);
  });
}

describe("stdio-bridge ↔ daemon /mcp", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  beforeAll(async () => { daemon = await startTestDaemon(); });
  afterAll(async () => { await daemon.close(); });

  test("AC-1: ask_user receives env-derived task_id", async () => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        VOS_DAEMON_BASE: `http://127.0.0.1:${daemon.port}`,
        VOS_AGENT: "maya",
        VOS_TASK_ID: "T-AC1",
        VOS_CONTEXT_ID: "C-AC1",
        VOS_RUN_ID: "R-AC1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await ping(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    // Fire-and-forget the ask_user call; resolve it from the test side.
    const callPromise = ping(child, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "ask_user", arguments: { question: "ping?" } },
    });
    // Wait until the daemon registers a pending ask, then resolve it.
    const ask = await daemon.waitForPending("T-AC1", 2_000);
    expect(ask.taskId).toBe("T-AC1");
    expect(ask.contextId).toBe("C-AC1");
    daemon.resolveAnswer(ask.toolUseId, "pong");
    const reply = await callPromise as { result?: { content: { text: string }[] } };
    expect(reply.result?.content[0].text).toBe("pong");
    child.kill("SIGTERM");
  });

  test("AC-2: ask_agent receives env-derived task_id", async () => {
    // AC-2 needs the spy wired BEFORE mountMcp captures deps. Construct a
    // per-test daemon with the spy pre-injected; the previously-started
    // shared `daemon` (used by AC-1, AC-4) is not reused here.
    const seen: { parentTaskId?: string; agent?: string } = {};
    const daemon2 = await startTestDaemon({
      dispatchChildTask: async (childId, args) => {
        const row = daemon2.db.prepare("SELECT parent_task_id FROM tasks WHERE id = ?").get(childId) as { parent_task_id: string };
        seen.parentTaskId = row.parent_task_id;
        seen.agent = args.agentName;
      },
    });
    // Pre-seed agent_cards so the permission gate accepts maya → bob.
    daemon2.db.prepare("INSERT OR REPLACE INTO agent_cards (agent_name, card_json) VALUES (?, ?)")
      .run("maya", JSON.stringify({ name: "maya", ask_agent_allow: ["bob"] }));
    daemon2.db.prepare("INSERT OR REPLACE INTO agent_cards (agent_name, card_json) VALUES (?, ?)")
      .run("bob", JSON.stringify({ name: "bob" }));
    try {

      const child = spawn(process.execPath, [BRIDGE], {
        env: {
          ...process.env,
          VOS_DAEMON_BASE: `http://127.0.0.1:${daemon2.port}`,
          VOS_AGENT: "maya",
          VOS_TASK_ID: "T-AC2",
          VOS_CONTEXT_ID: "C-AC2",
          VOS_RUN_ID: "R-AC2",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      await ping(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
      const reply = await ping(child, {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "ask_agent", arguments: { agent: "bob", message: "hi" } },
      }) as { result?: unknown; error?: unknown };
      expect(reply.error).toBeUndefined();
      expect(seen.parentTaskId).toBe("T-AC2");
      expect(seen.agent).toBe("bob");
      child.kill("SIGTERM");
    } finally {
      await daemon2.close();
    }
  });

  test("AC-6: missing required env → exit 1 with BRIDGE_CONFIG_FAIL on stdout", async () => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, VOS_AGENT: "maya" }, // VOS_DAEMON_BASE missing
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = await new Promise<string>((res) => {
      let buf = "";
      child.stdout!.on("data", (c) => { buf += c.toString("utf8"); });
      child.on("exit", () => res(buf));
    });
    expect(out).toMatch(/BRIDGE_CONFIG_FAIL/);
    expect(child.exitCode).toBe(1);
  });
});
```

If `startTestDaemon` does not yet exist, create it at `daemon/test/integration/helpers/start-test-daemon.ts` as a thin wrapper around the production `buildApp()` that returns the started port + handles. Keep it strictly a test helper (no production import surface).

- [ ] **Step 3: Run test**

Run: `cd workspace/void-os/daemon && bun test test/integration/stdio-bridge-e2e.test.ts`
Expected: all three subtests PASS. AC-1 and AC-6 are hard gates; AC-2 may need the agent_cards permission row seeded — handle inside the test setup.

- [ ] **Step 4: Commit**

```bash
cd workspace/void-os
git add daemon/test/integration/stdio-bridge-e2e.test.ts \
        daemon/test/integration/helpers/start-test-daemon.ts  # only if new
git commit -m "test(VOS-112): real-bridge integration covering AC-1/AC-2/AC-6 (T8)"
```

---

### Task 9: Concurrent-dispatch isolation (AC-4)

**Files:**
- Modify: `daemon/test/integration/stdio-bridge-e2e.test.ts`

Two bridges in parallel against two task ids; assert handler sees the right id per call AND a resolve for task A does not unblock task B. Catches a wrong-task answer-delivery bug per the forge-pass extension to AC-4.

- [ ] **Step 1: Add the test case**

Append inside the existing `describe`:

```ts
test("AC-4: concurrent same-agent dispatches stay disjoint at the handler AND at resolve", async () => {
  const spawnBridge = (taskId: string, contextId: string) => spawn(
    process.execPath, [BRIDGE],
    {
      env: {
        ...process.env,
        VOS_DAEMON_BASE: `http://127.0.0.1:${daemon.port}`,
        VOS_AGENT: "maya",
        VOS_TASK_ID: taskId,
        VOS_CONTEXT_ID: contextId,
        VOS_RUN_ID: `R-${taskId}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const a = spawnBridge("T-A", "C-A");
  const b = spawnBridge("T-B", "C-B");

  await ping(a, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  await ping(b, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });

  const aCall = ping(a, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_user", arguments: { question: "q-A" } } });
  const bCall = ping(b, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_user", arguments: { question: "q-B" } } });

  const askA = await daemon.waitForPending("T-A", 2_000);
  const askB = await daemon.waitForPending("T-B", 2_000);
  expect(askA.taskId).toBe("T-A");
  expect(askB.taskId).toBe("T-B");

  // Resolve A. B must remain pending — wrong-task cross-resolve guard.
  daemon.resolveAnswer(askA.toolUseId, "answer-A");
  const replyA = await aCall as { result?: { content: { text: string }[] } };
  expect(replyA.result?.content[0].text).toBe("answer-A");

  // B's call must still be pending. Race a 200ms timeout against bCall;
  // bCall winning would mean cross-resolve.
  const stillPending = await Promise.race([
    bCall.then(() => "resolved-too-soon"),
    new Promise((r) => setTimeout(() => r("pending"), 200)),
  ]);
  expect(stillPending).toBe("pending");

  daemon.resolveAnswer(askB.toolUseId, "answer-B");
  const replyB = await bCall as { result?: { content: { text: string }[] } };
  expect(replyB.result?.content[0].text).toBe("answer-B");

  a.kill("SIGTERM");
  b.kill("SIGTERM");
});
```

- [ ] **Step 2: Run test**

Run: `cd workspace/void-os/daemon && bun test test/integration/stdio-bridge-e2e.test.ts`
Expected: AC-4 PASS alongside earlier ACs.

- [ ] **Step 3: Commit**

```bash
cd workspace/void-os
git add daemon/test/integration/stdio-bridge-e2e.test.ts
git commit -m "test(VOS-112): AC-4 concurrent dispatches stay task-scoped (T9)"
```

---

### Task 10: Prompt-cache stability — structural assertion (AC-5)

**Files:**
- Modify: `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts`

The forge pass downgraded AC-5 from a live-API token-usage gate to a pure structural assertion: the only thing the stdio shape can newly bust is the MCP-side cache key, which is fingerprinted off the server's `command` + `args`. If those two fields are byte-equal across two consecutive `buildSpawnSettings` calls for the same agent (differing only by per-run `taskId` / `runId` / `contextId` in `env`), the MCP client cannot tell the second run is a different server — exactly what we need. The empirical Anthropic-side cache check stays as the manual gate in T11. This avoids inventing undefined helpers (`isClaudevAvailable`, `startProductionLikeDaemon`) and the paid-API CI cost.

- [ ] **Step 1: Write the failing test**

Append to `spawn-settings.test.ts`:

```ts
test("AC-5: mcp.json command+args are byte-equal across two consecutive spawns of the same agent (only env differs)", () => {
  const tmp1 = mkdtempSync(join(tmpdir(), "vos112-cache-1-"));
  const tmp2 = mkdtempSync(join(tmpdir(), "vos112-cache-2-"));
  const baseArgs = {
    agentName: "maya",
    scopes: { readPaths: [], writePaths: [] },
    systemDeny: [],
    vaultRoot: "/vault",
    daemonBase: "http://127.0.0.1:8729",
    hookScriptPath: "/hook.ts",
  };
  const a = buildSpawnSettings({
    ...baseArgs,
    runId:     "R-1",
    taskId:    "T-1",
    contextId: "C-1",
    settingsDir: tmp1,
  });
  const b = buildSpawnSettings({
    ...baseArgs,
    runId:     "R-2",
    taskId:    "T-2",
    contextId: "C-2",
    settingsDir: tmp2,
  });
  const mcpA = JSON.parse(readFileSync(a.mcpConfigPath, "utf8")) as {
    mcpServers: { "void-os": { command: string; args: string[]; env: Record<string, string> } };
  };
  const mcpB = JSON.parse(readFileSync(b.mcpConfigPath, "utf8")) as {
    mcpServers: { "void-os": { command: string; args: string[]; env: Record<string, string> } };
  };
  // Cache-keying fields must be byte-equal — this is what the MCP client
  // fingerprints. A divergence here would re-bust the Anthropic prompt cache
  // (same regression class as VOS-107).
  expect(mcpA.mcpServers["void-os"].command).toBe(mcpB.mcpServers["void-os"].command);
  expect(mcpA.mcpServers["void-os"].args).toEqual(mcpB.mcpServers["void-os"].args);
  // Env must differ on at least task_id (proof the cache-stable fields don't
  // accidentally absorb the per-run values).
  expect(mcpA.mcpServers["void-os"].env.VOS_TASK_ID).not.toBe(mcpB.mcpServers["void-os"].env.VOS_TASK_ID);
});
```

- [ ] **Step 2: Run test to verify it passes (or fails, depending on impl state)**

Run: `cd workspace/void-os/daemon && bun test src/providers/claude-code/__tests__/spawn-settings.test.ts`
Expected: PASS after T5 (which already produces stable `command`/`args`). If FAIL, it means T5's `BRIDGE_PATH` / `BUN_PATH` resolution accidentally depends on a per-call value — investigate before proceeding.

- [ ] **Step 3: Commit**

```bash
cd workspace/void-os
git add daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts
git commit -m "test(VOS-112): AC-5 cache-stable mcp.json command+args (T10)"
```

The empirical live-CC turn-2 cache check (the original VOS-107-shaped gate) is preserved as the manual VOS-107 UX repro in T11 Step 2.

---

### Task 11: Full-suite green + VOS-107 manual UX repro

**Files:**
- None (verification only)

- [ ] **Step 1: Run the full daemon suite**

Run: `cd workspace/void-os/daemon && bun test`
Expected: PASS, including the fake provider e2e (AC-3).

- [ ] **Step 2: Manual VOS-107 UX repro + empirical cache check**

Boot the void-os Obsidian plugin against a fresh daemon (per the project's local dev runbook), open a chat with the maya agent, send a prompt that triggers `vos_ask_user`. Confirm:
- the option buttons render in the UI (no raw JSON);
- selecting an option returns the answer to CC and the turn completes;
- the daemon log shows `_meta.task_id = <task id>` on the inbound `/mcp` POST.

Then drive a second turn in the SAME task and inspect the turn-2 trace's `assistant.usage` block:
- `cache_read_input_tokens > 0` AND `cache_creation_input_tokens` near zero — empirical AC-5 gate that the structural T10 assertion is intended to predict.
- If creation-spike returns, T10's structural assertion missed something (likely an additional MCP-cache-keyed field beyond command+args, e.g. server name or initialize-response shape) — investigate before /done.

This is the manual gate the task acceptance bullet ("Real CC spawn can call `vos_ask_user` and the daemon resolves the correct task_id") expects beyond the automated AC-1.

- [ ] **Step 3: Update task Work Log**

Append a session entry to `vault/work/tasks/active/VOS-112-*.md` via the `sw_run` helper (per /work workflow). Include: PASS / FAIL on each AC, manual repro outcome, commit SHAs.

- [ ] **Step 4: No commit (verification only); proceed to /done if all gates green.**

---

## Acceptance ↔ Task Map

| AC | Verified in task |
|---|---|
| AC-1 ask_user task_id stamped | T4 (unit), T8 (integration) |
| AC-2 ask_agent task_id stamped | T8 (integration) |
| AC-3 fake provider unchanged | T11 (full suite) |
| AC-4 concurrent dispatches disjoint + task-scoped resolve | T9 |
| AC-5 prompt cache stable | T10 (structural: byte-equal command+args), T11 step 2 (empirical: turn-2 usage) |
| AC-6 bridge fails fast on misconfig | T4 (smoke run), T8 (integration) |

## Out of scope (deferred — see spec §Out of scope)

- Removing the HTTP `/mcp` route.
- Migrating the fake provider to stdio.
- Codex / Gemini CLI provider implementations.
