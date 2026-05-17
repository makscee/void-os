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
  const stamped: Record<string, unknown> = {
    ...(msg.params._meta ?? {}),
    task_id: cfg.taskId,
    context_id: cfg.contextId,
  };
  if (cfg.runId !== null) stamped.run_id = cfg.runId;
  return { ...msg, params: { ...msg.params, _meta: stamped } };
}

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

// VOS-112 T8 fix: the MCP SDK's StdioServerTransport exposes `onmessage`
// and `onclose` as ASSIGNABLE PROPERTIES (its processReadBuffer calls
// `this.onmessage?.call(this, message)`), not as setter methods. The earlier
// shape here treated them as methods, which compiled clean only because
// main() cast `StdioServerTransport` via `as unknown as BridgeTransport`,
// and then crashed at runtime with "transport.onmessage is not a function"
// the moment a real subprocess booted. Match the SDK's actual contract.
export interface BridgeTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  send(msg: JsonRpcMessage): Promise<void>;
  onmessage?: (msg: JsonRpcMessage) => void;
  onclose?: () => void;
}

export async function runBridge(
  transport: BridgeTransport,
  cfg: BridgeConfig,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  transport.onmessage = (msg) => {
    void (async () => {
      const stamped = stampMeta(msg, cfg);
      const reply = await forwardToDaemon(stamped, cfg, fetchFn);
      await transport.send(reply);
    })();
  };
  transport.onclose = () => { /* SDK transport will end the process via main(). */ };
  await transport.start();
}

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
  process.stdin.on("close", () => process.exit(0));
  await runBridge(transport, cfg);
}

if (import.meta.main) {
  void main();
}
