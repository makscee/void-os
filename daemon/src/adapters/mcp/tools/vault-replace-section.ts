/**
 * vault.replace_section MCP tool (VOS-108).
 *
 * Input: { path, section, content }
 * Errors: PATH_*, SCOPE_DENIED, NOT_FOUND, SECTION_NOT_FOUND, IO_ERROR.
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

export const vaultReplaceSectionInput = {
  path: z.string().min(1),
  section: z.string().min(1),
  content: z.string(),
} satisfies z.ZodRawShape;

export const vaultReplaceSectionDef = {
  description: "Replace the body of a markdown heading section in a vault file.",
  inputSchema: vaultReplaceSectionInput,
};

export interface VaultReplaceSectionDeps {
  vaultRoot: string;
  db: Database;
  engine: PermissionEngine;
  agent: AgentDefn;
  writer: VaultWriter;
}

export function makeVaultReplaceSection(deps: VaultReplaceSectionDeps) {
  const { vaultRoot, engine, agent, writer } = deps;
  return async (
    args: z.objectOutputType<typeof vaultReplaceSectionInput, z.ZodTypeAny>,
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
      await writer.replace_section(rel, args.section, args.content, mcpRunCtx(extra, agent.name));
    } catch (e) {
      const code = (e as { code?: string }).code;
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") return errResult("NOT_FOUND", `${rel}: not found`);
      if (code === "SECTION_NOT_FOUND") return errResult("SECTION_NOT_FOUND", `${rel}: section ${args.section} not found`);
      return errResult("IO_ERROR", (e as Error).message);
    }

    return {
      content: [{ type: "text", text: `replaced section ${args.section} in ${rel}` }],
      structuredContent: { path: rel, section: args.section },
    };
  };
}
