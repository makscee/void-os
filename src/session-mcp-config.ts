// session-mcp-config.ts — VOS-225 P1 §2. Generate the per-session .mcp.json that points every
// spawned CC session (agent OR plain) at the shared daemon-hosted MCP transport (§2 contract).
//
// Frozen contract: server key = "void-os-vault", url = http://127.0.0.1:<port>/mcp, transport
// type "http" (streamable-HTTP — the SDK's WebStandardStreamableHTTPServerTransport, §2.1).
// Plain (agent-less) sessions also get this config so the tools are universally available.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const VAULT_MCP_SERVER_KEY = "void-os-vault";

export interface McpServerEntry {
  type: string;
  url?: string;
  command?: string;
  [k: string]: unknown;
}
export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** Build the session .mcp.json body, merging the daemon-vault server into any existing block. */
export function buildSessionMcpConfig(port: number, base?: Partial<McpConfig>): McpConfig {
  const servers: Record<string, McpServerEntry> = { ...(base?.mcpServers ?? {}) };
  servers[VAULT_MCP_SERVER_KEY] = {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
  };
  return { mcpServers: servers };
}

/**
 * Write a per-session .mcp.json and return its absolute path.
 * If `agentConfigPath` is given (an agent's restricted-MCP file), its servers are merged so the
 * agent keeps its own MCP servers AND gains the vault server. The written file is per-session
 * (keyed on runId) so concurrent spawns never clobber each other.
 */
export function writeSessionMcpConfig(
  vault: string,
  runId: string,
  port: number,
  agentConfigPath?: string | null,
): string {
  let base: Partial<McpConfig> | undefined;
  if (agentConfigPath && existsSync(agentConfigPath)) {
    try { base = JSON.parse(readFileSync(agentConfigPath, "utf8")) as Partial<McpConfig>; }
    catch { base = undefined; }
  }
  const cfg = buildSessionMcpConfig(port, base);
  const dir = join(vault, ".void-os", "session-mcp");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${runId}.json`);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return p;
}
