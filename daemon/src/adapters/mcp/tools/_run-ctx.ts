/**
 * VOS-108: synthesize VaultWriter's WriteCtx from MCP request metadata.
 *
 * WriteCtx = { agent: string; run_id: string }. _meta.run_id (per VOS-97
 * ADR-0002) is preferred; otherwise we mint a synthetic `mcp-<uuid>` so the
 * writer's logging/staging still has a stable id.
 */
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { WriteCtx } from "../../../vault/writer.ts";

export function mcpRunCtx(extra: RequestHandlerExtra<any, any>, agentName: string): WriteCtx {
  const meta = (extra as { _meta?: { run_id?: unknown } })._meta;
  const rawRunId = meta && typeof meta.run_id === "string" ? meta.run_id : "";
  const run_id = rawRunId.length > 0 ? rawRunId : `mcp-${crypto.randomUUID()}`;
  return { agent: agentName, run_id };
}
