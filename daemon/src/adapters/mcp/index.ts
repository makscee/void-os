/**
 * void-os MCP server. Exposes daemon ops as MCP tools over Streamable HTTP at /mcp.
 *
 * Mount via `mountMcp(app, { vaultRoot, db })`. Per request we create a fresh
 * StreamableHTTPServerTransport (stateless mode) and dispatch through the
 * Hono↔SDK bridge.
 */

import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import pkg from "../../../package.json" with { type: "json" };
import { honoBridge } from "./hono-bridge.ts";
import { handleVaultRead, vaultReadDef } from "./tools/vault-read.ts";

export interface McpDeps {
  vaultRoot: string;
  db: Database;
}

export function buildMcpServer(deps: McpDeps): Server {
  const server = new Server(
    { name: "void-os", version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [vaultReadDef],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    if (name !== "vault.read") {
      return { isError: true, content: [{ type: "text", text: `UNKNOWN_TOOL: ${name}` }] };
    }
    const res = await handleVaultRead(args as { path: string }, { vaultRoot: deps.vaultRoot, db: deps.db });
    // VaultReadOk/Err are stricter than CallToolResult (no index signature).
    // The shapes match the spec; widen to CallToolResult here.
    return res as unknown as CallToolResult;
  });

  return server;
}

export function mountMcp(app: Hono, deps: McpDeps): void {
  app.all("/mcp", async (c) => {
    const server = buildMcpServer(deps);
    // Stateless mode: each request gets a fresh server+transport. Setting
    // sessionIdGenerator to undefined disables session tracking; otherwise
    // the SDK requires clients to echo back an mcp-session-id, which can't
    // work when every request lands on a brand-new transport instance.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);

    // Single source of truth for the request body:
    //  - POST + JSON: parse once and pass as `parsedBody`. The bridge's
    //    `nodeReq` is built AFTER consumption — its stream is empty, so the
    //    SDK cannot accidentally re-read.
    //  - GET (SSE resume) / empty body: no parsing, SDK consumes `nodeReq`.
    const ctype = c.req.header("content-type") ?? "";
    let parsedBody: unknown | undefined;
    if (c.req.method === "POST" && ctype.includes("json")) {
      parsedBody = await c.req.json();
    }

    const { nodeReq, nodeRes, responsePromise } = honoBridge(c);
    void transport.handleRequest(nodeReq as never, nodeRes as never, parsedBody);
    return responsePromise;
  });
}
