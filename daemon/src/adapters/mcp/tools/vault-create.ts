/**
 * vault.create MCP tool (VOS-108).
 *
 * Input:  { path: string, content: string }
 * Output: { content: [{type:'text', text}], structuredContent: {path, sha, bytes} }
 *         or { isError: true, content: [{type:'text', text: '<CODE>: <message>'}] }
 *
 * Error codes: PATH_MUST_BE_RELATIVE, PATH_ESCAPES_VAULT_ROOT, SCOPE_DENIED,
 *              FILE_EXISTS, IO_ERROR.
 */
import { z } from "zod/v3";
import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Database } from "bun:sqlite";
import { resolveVaultPath, ERR } from "../../../vault/paths.ts";
import type { PermissionEngine, AgentDefn } from "../../../permissions/engine.ts";
import type { VaultWriter } from "../../../vault/writer.ts";
import { assertCanWrite, errResult } from "./_scope-gate.ts";
import { mcpRunCtx } from "./_run-ctx.ts";

export const vaultCreateInput = {
  path: z.string().min(1),
  content: z.string(),
} satisfies z.ZodRawShape;

export const vaultCreateDef = {
  description: "Create a new file in the vault. Errors if the path already exists.",
  inputSchema: vaultCreateInput,
};

export interface VaultCreateDeps {
  vaultRoot: string;
  db: Database;
  engine: PermissionEngine;
  agent: AgentDefn;
  writer: VaultWriter;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function makeVaultCreate(deps: VaultCreateDeps) {
  const { vaultRoot, engine, agent, writer } = deps;
  return async (
    args: z.objectOutputType<typeof vaultCreateInput, z.ZodTypeAny>,
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
      await writer.create(rel, args.content, mcpRunCtx(extra, agent.name));
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EEXIST") return errResult("FILE_EXISTS", `${rel}: already exists`);
      return errResult("IO_ERROR", (e as Error).message);
    }

    const sha = sha256(args.content);
    const bytes = Buffer.byteLength(args.content);
    return {
      content: [{ type: "text", text: `wrote ${bytes} bytes to ${rel}` }],
      structuredContent: { path: rel, sha, bytes },
    };
  };
}
