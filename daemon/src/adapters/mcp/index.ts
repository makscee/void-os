// MCP server. Exposes daemon ops (vault.*, ask_user, run_skill, spawn_worktree_task)
// as MCP tools over stdio to every CC subprocess.

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<unknown>;
}

export interface McpServer {
  register(tool: McpToolDef): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const createMcpServer = (): McpServer => {
  throw new Error("not implemented");
};
