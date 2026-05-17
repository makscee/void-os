/**
 * vault.patch MCP tool (VOS-108).
 *
 * Input: { path, old_string, new_string }
 *   old_string must occur exactly once in the file.
 * Errors: PATH_*, SCOPE_DENIED, NOT_FOUND, OLD_STRING_NOT_FOUND,
 *         OLD_STRING_NOT_UNIQUE, IO_ERROR.
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

export const vaultPatchInput = {
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
} satisfies z.ZodRawShape;

export const vaultPatchDef = {
  description: "Replace a unique substring (old_string) with new_string in a vault file.",
  inputSchema: vaultPatchInput,
};

export interface VaultPatchDeps {
  vaultRoot: string;
  db: Database;
  engine: PermissionEngine;
  agent: AgentDefn;
  writer: VaultWriter;
}

export function makeVaultPatch(deps: VaultPatchDeps) {
  const { vaultRoot, engine, agent, writer } = deps;
  return async (
    args: z.objectOutputType<typeof vaultPatchInput, z.ZodTypeAny>,
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
      await writer.patch(rel, args.old_string, args.new_string, mcpRunCtx(extra, agent.name));
    } catch (e) {
      const code = (e as { code?: string }).code;
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") return errResult("NOT_FOUND", `${rel}: not found`);
      if (code === "OLD_STRING_NOT_FOUND") return errResult("OLD_STRING_NOT_FOUND", `${rel}: old_string not found`);
      if (code === "OLD_STRING_NOT_UNIQUE") return errResult("OLD_STRING_NOT_UNIQUE", `${rel}: old_string not unique`);
      return errResult("IO_ERROR", (e as Error).message);
    }

    return {
      content: [{ type: "text", text: `patched ${rel}` }],
      structuredContent: { path: rel },
    };
  };
}
