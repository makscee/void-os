/**
 * vault.read MCP tool — factory + Zod input shape (VOS-97).
 *
 * Input:  { path: string }              — vault-relative
 * Output: { content: [{type:'text', text}], structuredContent: {path, sha, bytes} }
 *         or { isError: true, content: [{type:'text', text: '<CODE>: <message>'}] }
 *
 * Error codes (preserved byte-for-byte from prior handleVaultRead):
 *   PATH_MUST_BE_RELATIVE, PATH_ESCAPES_VAULT_ROOT, ENOENT, NOT_A_FILE, IO_ERROR.
 */

import { z } from "zod";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Database } from "bun:sqlite";
import { resolveVaultPath, ERR } from "../../../vault/paths.ts";

export const vaultReadInput = {
  path: z.string().min(1),
} satisfies z.ZodRawShape;

export const vaultReadDef = {
  description:
    "Read a file from the vault by relative path. Returns content and a content-addressed sha.",
  inputSchema: vaultReadInput,
};

export interface VaultReadDeps {
  vaultRoot: string;   // resolved absolute path
  db: Database;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function errResult(code: string, msg: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${code}: ${msg}` }] };
}

export function makeVaultRead(deps: VaultReadDeps) {
  const { vaultRoot } = deps;
  return async (
    args: z.objectOutputType<typeof vaultReadInput, z.ZodTypeAny>,
    _extra: RequestHandlerExtra<any, any>,
  ): Promise<CallToolResult> => {
    const rel = args.path;
    let abs: string;
    try {
      abs = resolveVaultPath(rel, vaultRoot);
    } catch (e) {
      const code = (e instanceof Error && (e.message === ERR.PATH_MUST_BE_RELATIVE || e.message === ERR.PATH_ESCAPES_VAULT_ROOT))
        ? e.message
        : "IO_ERROR";
      return errResult(code, (e as Error).message);
    }

    let stat;
    try {
      stat = fsSync.statSync(abs);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      const code = errno === "ENOENT" ? "ENOENT" : "IO_ERROR";
      return errResult(code, (e as Error).message);
    }

    if (!stat.isFile()) {
      return errResult("NOT_A_FILE", `${rel} is not a regular file`);
    }

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (e) {
      return errResult("IO_ERROR", (e as Error).message);
    }

    const sha = sha256(content);
    const bytes = Buffer.byteLength(content);
    return {
      content: [{ type: "text", text: content }],
      structuredContent: { path: rel, sha, bytes },
    };
  };
}
