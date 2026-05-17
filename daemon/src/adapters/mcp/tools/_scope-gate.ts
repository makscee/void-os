/**
 * VOS-108: shared scope-gate helpers for vault.* write MCP tools.
 *
 * `errResult` mirrors the byte-for-byte shape used by vault.read so that the
 * MCP-level error envelope is identical across read and write paths.
 *
 * `assertCanWrite` / `assertCanRead` return `null` when the access is permitted,
 * or a `SCOPE_DENIED` CallToolResult ready to return from the tool handler.
 * Callers must run path resolution (`resolveVaultPath`) BEFORE calling these —
 * the absolute path is what the engine matches against.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PermissionEngine, AgentDefn } from "../../../permissions/engine.ts";

export function errResult(code: string, msg: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${code}: ${msg}` }] };
}

export function assertCanWrite(
  engine: PermissionEngine,
  agent: AgentDefn,
  relPath: string,
  absPath: string,
): CallToolResult | null {
  if (engine.canWrite(absPath, agent)) return null;
  return errResult("SCOPE_DENIED", `${relPath} outside write_scope for agent ${agent.name}`);
}

export function assertCanRead(
  engine: PermissionEngine,
  agent: AgentDefn,
  relPath: string,
  absPath: string,
): CallToolResult | null {
  if (engine.canRead(absPath, agent)) return null;
  return errResult("SCOPE_DENIED", `${relPath} outside read_scope for agent ${agent.name}`);
}
