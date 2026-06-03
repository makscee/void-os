// vault-mcp.ts — VOS-225 P1. The daemon-hosted SHARED MCP surface (§1 of vault-mcp-v1-contracts).
//
// Four v1 tools — vault.write, vault.append, page.register, page.list. NO session.* (v2), NO
// vault.read (reads stay native fs, augment-native-fs). The daemon hosts ONE instance; every
// spawned CC session reaches it via a generated .mcp.json (§2, session-mcp-config.ts).
//
// Trust model (R-2): exec_id is SELF-REPORTED provenance, recorded verbatim in the audit line,
// NOT verified in v1 (sandbox + audit-only). SYSTEM_DENY (§1.5) hard-blocks the MCP write path
// and emits a denied:true audit line (v2-enforcement seam).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { appendAudit } from "./audit.ts";
import { isValidSlug, upsertPage, readManifest } from "./pages.ts";

// ── §1 tool schemas ──────────────────────────────────────────────────────────
const WRITE_SCHEMA = {
  type: "object" as const,
  properties: {
    path: { type: "string", description: "vault-relative file path to overwrite-write" },
    content: { type: "string", description: "full new file content" },
    exec_id: { type: "string", description: "calling CC run id (self-reported, audit provenance)" },
  },
  required: ["path", "content"],
};

export const VAULT_TOOLS = [
  {
    name: "vault.write",
    description: "Overwrite-write a vault file (creates parent dirs). Audited (source:mcp). System paths are blocked.",
    inputSchema: WRITE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "vault.append",
    description: "Append to a vault file (O_APPEND, concurrent-safe). Audited (source:mcp). System paths are blocked.",
    inputSchema: WRITE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "page.register",
    description: "Register or update a live page in panels/manifest.json (idempotent upsert by slug). New pages are pinned to the left-nav.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: { type: "string", description: "page slug (^[a-z0-9][a-z0-9-]{0,62}$)" },
        title: { type: "string", description: "nav label" },
        path: { type: "string", description: "vault-relative html file the page serves (e.g. panels/kanban.html)" },
        exec_id: { type: "string" },
      },
      required: ["slug", "title", "path"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "page.list",
    description: "List registered live pages from panels/manifest.json. Returns a JSON array of {slug,title,path,pinned}.",
    inputSchema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
];

// ── §1.5 SYSTEM_DENY (frozen path set) ───────────────────────────────────────
// vault-relative globs hard-blocked in vault.write/vault.append.
const SYSTEM_DENY = [/^agents\//, /^\.void-os\//, /^\.claude\//];
function isDenied(rel: string): boolean {
  return SYSTEM_DENY.some((re) => re.test(rel));
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/**
 * Resolve a user-supplied vault-relative path. Returns the absolute path + the normalized
 * vault-relative path, or null if it escapes the vault.
 */
function resolveVaultPath(vault: string, p: string): { abs: string; rel: string } | null {
  const root = resolve(vault);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return { abs, rel };
}

function execOf(args: Record<string, unknown>): string {
  const e = args.exec_id;
  return typeof e === "string" && e ? e : `mcp-${randomUUID()}`;
}

/**
 * Dispatch a single vault-MCP tool call. THE shared code path — both the in-process MCP
 * CallToolRequest handler and the proof/tests route through here. Async to match the MCP
 * handler signature (no actual await today, but page.register serialization may add one).
 */
export async function callVaultTool(
  vault: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const exec = execOf(args);
  const agent = typeof args.agent === "string" ? (args.agent as string) : null;

  if (name === "vault.write" || name === "vault.append") {
    const path = String(args.path ?? "");
    const content = String(args.content ?? "");
    const resolved = resolveVaultPath(vault, path);
    if (!resolved) return err("path escapes vault");
    const bytes = Buffer.byteLength(content);
    if (isDenied(resolved.rel)) {
      // audit-only block: record the attempt with denied:true (v2-enforcement seam)
      appendAudit(vault, { ts: Date.now(), exec, agent, tool: name, path: resolved.rel, bytes, source: "mcp", denied: true });
      return err(`SYSTEM_DENY: ${path}`);
    }
    mkdirSync(dirname(resolved.abs), { recursive: true });
    if (name === "vault.write") {
      writeFileSync(resolved.abs, content);
    } else {
      appendFileSync(resolved.abs, content, { flag: "a" }); // O_APPEND
    }
    appendAudit(vault, { ts: Date.now(), exec, agent, tool: name, path: resolved.rel, bytes, source: "mcp" });
    return ok(name === "vault.write" ? `wrote ${path} (${bytes}b)` : `appended ${path} (+${bytes}b)`);
  }

  if (name === "page.register") {
    const slug = String(args.slug ?? "");
    const title = String(args.title ?? "");
    const path = String(args.path ?? "");
    if (!isValidSlug(slug)) return err(`invalid slug: ${slug}`);
    return await registerPage(vault, { slug, title, path, exec, agent });
  }

  if (name === "page.list") {
    const pages = readManifest(vault).pages;
    return ok(JSON.stringify(pages));
  }

  return err(`Unknown tool: ${name}`);
}

// ── page.register serialization (§3.2) ───────────────────────────────────────
// One process → a simple promise-chain mutex serializes concurrent register calls so the
// read-modify-write of manifest.json is atomic. No SQLite (files-first, §0).
let registerLock: Promise<void> = Promise.resolve();
async function registerPage(
  vault: string,
  e: { slug: string; title: string; path: string; exec: string; agent: string | null },
): Promise<CallToolResult> {
  let release!: () => void;
  const prior = registerLock;
  registerLock = new Promise<void>((res) => { release = res; });
  await prior;
  try {
    upsertPage(vault, { slug: e.slug, title: e.title, path: e.path });
    // The manifest write itself is audited as a vault.write on panels/manifest.json (§1.3).
    const rel = "panels/manifest.json";
    const bytes = Buffer.byteLength(JSON.stringify(readManifest(vault)));
    appendAudit(vault, { ts: Date.now(), exec: e.exec, agent: e.agent, tool: "vault.write", path: rel, bytes, source: "mcp" });
    return ok(`registered ${e.slug} -> ${e.path}`);
  } finally {
    release();
  }
}

/**
 * Build the daemon-hosted MCP Server instance exposing the four v1 tools. ONE instance is
 * created per daemon (serve.ts); all sessions share it via the §2 streamable-HTTP transport.
 * The "nav_changed" / page-register SSE fan-out is wired by the daemon (server.ts) via the
 * onNavChanged callback — kept out of this module so tool dispatch stays transport-agnostic.
 */
export function createVaultMcpServer(vault: string, onNavChanged?: () => void): Server {
  const server = new Server(
    { name: "void-os-vault", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: VAULT_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await callVaultTool(vault, name, (args ?? {}) as Record<string, unknown>);
    if (name === "page.register" && !result.isError && onNavChanged) {
      try { onNavChanged(); } catch { /* never fail the tool on a fan-out hiccup */ }
    }
    return result;
  });
  return server;
}
