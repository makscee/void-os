/**
 * vault.move MCP tool (VOS-108).
 *
 * Input: { from, to }
 * Triple-gate: canRead(from) + canWrite(from) + canWrite(to). The read gate
 * on `from` prevents agents with write-only-no-read scope from learning
 * source-path existence (info-leak / confused-deputy mitigation — see spec).
 * Errors: PATH_*, SCOPE_DENIED, NOT_FOUND, FILE_EXISTS, IO_ERROR.
 */
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Database } from "bun:sqlite";
import { resolveVaultPath, ERR } from "../../../vault/paths.ts";
import type { PermissionEngine, AgentDefn } from "../../../permissions/engine.ts";
import type { VaultWriter } from "../../../vault/writer.ts";
import { assertCanRead, assertCanWrite, errResult } from "./_scope-gate.ts";
import { mcpRunCtx } from "./_run-ctx.ts";

export const vaultMoveInput = {
  from: z.string().min(1),
  to: z.string().min(1),
} satisfies z.ZodRawShape;

export const vaultMoveDef = {
  description: "Move (rename) a vault file from one relative path to another.",
  inputSchema: vaultMoveInput,
};

export interface VaultMoveDeps {
  vaultRoot: string;
  db: Database;
  engine: PermissionEngine;
  agent: AgentDefn;
  writer: VaultWriter;
}

function resolveOrErr(rel: string, vaultRoot: string): { abs: string } | { err: CallToolResult } {
  try {
    return { abs: resolveVaultPath(rel, vaultRoot) };
  } catch (e) {
    const msg = (e as Error).message;
    const code = msg === ERR.PATH_MUST_BE_RELATIVE || msg === ERR.PATH_ESCAPES_VAULT_ROOT ? msg : "IO_ERROR";
    return { err: errResult(code, msg) };
  }
}

export function makeVaultMove(deps: VaultMoveDeps) {
  const { vaultRoot, engine, agent, writer } = deps;
  return async (
    args: z.objectOutputType<typeof vaultMoveInput, z.ZodTypeAny>,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<CallToolResult> => {
    const from = args.from;
    const to = args.to;

    const fromR = resolveOrErr(from, vaultRoot);
    if ("err" in fromR) return fromR.err;
    const toR = resolveOrErr(to, vaultRoot);
    if ("err" in toR) return toR.err;

    // Triple-gate, in order:
    const readDenied = assertCanRead(engine, agent, from, fromR.abs);
    if (readDenied) return readDenied;
    const writeFromDenied = assertCanWrite(engine, agent, from, fromR.abs);
    if (writeFromDenied) return writeFromDenied;
    const writeToDenied = assertCanWrite(engine, agent, to, toR.abs);
    if (writeToDenied) return writeToDenied;

    try {
      await writer.move(from, to, mcpRunCtx(extra, agent.name));
    } catch (e) {
      const code = (e as { code?: string }).code;
      const errno = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return errResult("FILE_EXISTS", `${to}: already exists`);
      if (errno === "ENOENT") return errResult("NOT_FOUND", `${from}: not found`);
      return errResult("IO_ERROR", (e as Error).message);
    }

    return {
      content: [{ type: "text", text: `moved ${from} → ${to}` }],
      structuredContent: { from, to },
    };
  };
}
