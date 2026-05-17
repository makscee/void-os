/**
 * vault.set_property MCP tool (VOS-108).
 *
 * Input: { path, property, value }
 *   value is JSON-able: string | number | boolean | null | array<scalar>.
 *   Nested objects are intentionally not supported (use vault.patch for that).
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

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const valueSchema = z.union([scalarSchema, z.array(scalarSchema)]);

export const vaultSetPropertyInput = {
  path: z.string().min(1),
  property: z.string().min(1),
  value: valueSchema,
} satisfies z.ZodRawShape;

export const vaultSetPropertyDef = {
  description: "Set a frontmatter property in a vault file. Value may be a scalar or an array of scalars.",
  inputSchema: vaultSetPropertyInput,
};

export interface VaultSetPropertyDeps {
  vaultRoot: string;
  db: Database;
  engine: PermissionEngine;
  agent: AgentDefn;
  writer: VaultWriter;
}

export function makeVaultSetProperty(deps: VaultSetPropertyDeps) {
  const { vaultRoot, engine, agent, writer } = deps;
  return async (
    args: z.objectOutputType<typeof vaultSetPropertyInput, z.ZodTypeAny>,
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
      await writer.set_property(rel, args.property, args.value, mcpRunCtx(extra, agent.name));
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") return errResult("NOT_FOUND", `${rel}: not found`);
      return errResult("IO_ERROR", (e as Error).message);
    }

    return {
      content: [{ type: "text", text: `set ${args.property} on ${rel}` }],
      structuredContent: { path: rel, property: args.property },
    };
  };
}
