/**
 * vault.read MCP tool.
 *
 * Input:  { path: string }              — vault-relative
 * Output: { content: [{type:'text', text}], structuredContent: {path, sha, bytes} }
 *         or { isError: true, content: [{type:'text', text: '<CODE>: <message>'}] }
 *
 * Error codes: PATH_MUST_BE_RELATIVE, PATH_ESCAPES_VAULT_ROOT, ENOENT,
 *              NOT_A_FILE, IO_ERROR. Every call records an event row.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { createHash } from "node:crypto";
import { resolveVaultPath, ERR } from "../../../vault/paths.ts";
import { recordMcpEvent } from "../events.ts";
import type { Database } from "bun:sqlite";

export const vaultReadDef = {
  name: "vault.read",
  description: "Read a file from the vault by relative path. Returns content and a content-addressed sha.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: { type: "string" as const, description: "Path relative to vault root. Must not escape root." },
    },
    required: ["path"] as const,
    additionalProperties: false as const,
  },
};

export interface VaultReadDeps {
  vaultRoot: string;   // resolved absolute path
  db: Database;
  runId?: string | null;
}

export interface VaultReadOk {
  isError?: false;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { path: string; sha: string; bytes: number };
}

export interface VaultReadErr {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: undefined;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function errResult(code: string, msg: string): VaultReadErr {
  return { isError: true, content: [{ type: "text", text: `${code}: ${msg}` }] };
}

export async function handleVaultRead(
  args: { path: string },
  deps: VaultReadDeps,
): Promise<VaultReadOk | VaultReadErr> {
  const rel = args.path;
  let abs: string;
  try {
    abs = resolveVaultPath(rel, deps.vaultRoot);
  } catch (e) {
    const code = (e instanceof Error && (e.message === ERR.PATH_MUST_BE_RELATIVE || e.message === ERR.PATH_ESCAPES_VAULT_ROOT))
      ? e.message
      : "IO_ERROR";
    recordMcpEvent(deps.db, { tool: "vault.read", input: { path: rel }, ok: false, error_code: code, run_id: deps.runId ?? null });
    return errResult(code, (e as Error).message);
  }

  let stat;
  try {
    stat = fsSync.statSync(abs);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    const code = errno === "ENOENT" ? "ENOENT" : "IO_ERROR";
    recordMcpEvent(deps.db, { tool: "vault.read", input: { path: rel }, ok: false, error_code: code, run_id: deps.runId ?? null });
    return errResult(code, (e as Error).message);
  }

  if (!stat.isFile()) {
    recordMcpEvent(deps.db, { tool: "vault.read", input: { path: rel }, ok: false, error_code: "NOT_A_FILE", run_id: deps.runId ?? null });
    return errResult("NOT_A_FILE", `${rel} is not a regular file`);
  }

  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch (e) {
    recordMcpEvent(deps.db, { tool: "vault.read", input: { path: rel }, ok: false, error_code: "IO_ERROR", run_id: deps.runId ?? null });
    return errResult("IO_ERROR", (e as Error).message);
  }

  const sha = sha256(content);
  const bytes = Buffer.byteLength(content);
  recordMcpEvent(deps.db, { tool: "vault.read", input: { path: rel }, ok: true, result_sha: sha, run_id: deps.runId ?? null });
  return {
    content: [{ type: "text", text: content }],
    structuredContent: { path: rel, sha, bytes },
  };
}
