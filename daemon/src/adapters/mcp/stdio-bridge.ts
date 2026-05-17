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
