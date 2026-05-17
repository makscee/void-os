/**
 * vault.delete MCP tool (VOS-108).
 *
 * Input: { path }
 * Errors: PATH_*, SCOPE_DENIED, NOT_FOUND, IO_ERROR.
 */
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Database } from "bun:sqlite";
import { resolveVaultPath, ERR } from "../../../vault/paths.ts";
import type { PermissionEngine, AgentDefn } from "../../../permissions/engine.ts";
import type { VaultWriter } from "../../../vault/writer.ts";
import { assertCanWrite, errResult } from "./_scope-gate.ts";
import { mcpRunCtx } from "./_run-ctx.ts";

export const vaultDeleteInput = {
  path: z.string().min(1),
} satisfies z.ZodRawShape;

export const vaultDeleteDef = {
  description: "Delete a vault file by relative path.",
  inputSchema: vaultDeleteInput,
};

export interface VaultDeleteDeps {
  vaultRoot: string;
  db: Database;
  engine: PermissionEngine;
  agent: AgentDefn;
  writer: VaultWriter;
}

export function makeVaultDelete(deps: VaultDeleteDeps) {
  const { vaultRoot, engine, agent, writer } = deps;
  return async (
    args: z.objectOutputType<typeof vaultDeleteInput, z.ZodTypeAny>,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<CallToolResult> => {
    const rel = args.path;
    let abs: string;
    try {
      abs = resolveVaultPath(rel, vaultRoot);
    } catch (e) {
      const msg = (e as Error).message;
      const code = msg === ERR.PATH_MUST_BE_RELATIVE || msg === ERR.PATH_ESCAPES_VAULT_ROOT ? msg : "IO_ERROR";
      return errResult(code, msg);
    }

    const denied = assertCanWrite(engine, agent, rel, abs);
    if (denied) return denied;

    try {
      await writer.delete(rel, mcpRunCtx(extra, agent.name));
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") return errResult("NOT_FOUND", `${rel}: not found`);
      return errResult("IO_ERROR", (e as Error).message);
    }

    return {
      content: [{ type: "text", text: `deleted ${rel}` }],
      structuredContent: { path: rel },
    };
  };
}
