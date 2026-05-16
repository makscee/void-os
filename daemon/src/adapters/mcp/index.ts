/**
 * void-os MCP server. Exposes daemon ops as MCP tools over Streamable HTTP at /mcp.
 *
 * Mount via `mountMcp(app, { vaultRoot, db, bus })`. Per request we create a fresh
 * StreamableHTTPServerTransport (stateless mode) and dispatch through the
 * Hono↔SDK bridge.
 *
 * VOS-97: tools are now wired via `McpServer.registerTool`. Each tool exports
 * a `*Def` + `make*(deps)` factory; per-request runtime ids (`task_id`,
 * `context_id`, `run_id`) and the `_vos_tool_use_id` correlation hint travel
 * in `params._meta` per MCP spec (see ADR-0002 + Task 1 spike outcome).
 *
 * VOS-100: ask_user state (parked awaiters + CAS + history append + bus
 * emission) lives behind `AskUserBridge` (src/chat/ask-user-bridge.ts).
 * The bridge is constructed ONCE in the composition root (app.ts) and the
 * same instance is threaded into both `mountMcp` (the ask_user handler
 * parks awaiters via `bridge.open()`) and `mountAnswerRoute` (the HTTP
 * /answer route resolves them via `bridge.resolve()`). Replaces the old
 * module-singleton `pendingRegistry`.
 */

import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pkg from "../../../package.json" with { type: "json" };
import type { EventBus } from "../../events/index.ts";
import type { AgentDefn } from "../../permissions/engine.ts";
import type { AskUserBridge } from "../../chat/ask-user-bridge.ts";
import { honoBridge } from "./hono-bridge.ts";
import { vaultReadDef, makeVaultRead } from "./tools/vault-read.ts";
import { askUserDef, makeAskUser } from "./tools/ask-user.ts";
import { askAgentDef, makeAskAgent } from "./tools/ask-agent.ts";

export interface McpDeps {
  vaultRoot: string;
  db: Database;
  bus: EventBus;
  bridge: AskUserBridge;
  /**
   * VOS-89 T10: optional override for the AgentDefn loader. When omitted,
   * a default implementation reads `agent_cards.card_json` and parses it.
   * Tests inject a stub to avoid populating agent_cards.
   */
  loadAgentDefn?: (agentName: string) => AgentDefn;
  /**
   * Dispatcher for freshly-minted child Tasks. Production buildApp passes
   * the real implementation from `daemon/src/chat/dispatch-child.ts`
   * (VOS-89 T15.5); MCP-only tests that don't need a child to actually
   * run can omit this and rely on the placeholder, which logs a warning
   * and returns. The placeholder is intentionally noisy so a misconfigured
   * production wire surfaces in logs rather than silently dropping
   * children on the floor.
   */
  dispatchChildTask?: (
    childTaskId: string,
    args: { agentName: string; message: string; systemMessage?: string },
  ) => Promise<void>;
}

/**
 * VOS-89 T10: default AgentDefn loader — reads `agent_cards.card_json`
 * and parses it. The card JSON is expected to carry at least `name`;
 * `ask_agent_allow` is optional, and when absent the field is left
 * `undefined` (NOT empty array), which the permission gate in
 * ask_agent treats as permissive at the agent level.
 */
export function defaultLoadAgentDefn(db: Database, agentName: string): AgentDefn {
  const row = db
    .query("SELECT card_json FROM agent_cards WHERE agent_name = ?")
    .get(agentName) as { card_json: string } | undefined;
  if (!row) {
    throw new Error(`unknown agent: ${agentName}`);
  }
  const parsed = JSON.parse(row.card_json) as Record<string, unknown>;
  const defn: AgentDefn = { name: agentName };
  if (Array.isArray(parsed.ask_agent_allow)) {
    defn.ask_agent_allow = parsed.ask_agent_allow as string[];
  }
  if (Array.isArray(parsed.read_scope)) {
    defn.read_scope = parsed.read_scope as string[];
  }
  if (Array.isArray(parsed.write_scope)) {
    defn.write_scope = parsed.write_scope as string[];
  }
  return defn;
}

export function buildMcpServer(deps: McpDeps): Server {
  const { vaultRoot, db, bus, bridge } = deps;
  const loadAgentDefn =
    deps.loadAgentDefn ?? ((name: string) => defaultLoadAgentDefn(db, name));
  const dispatchChildTask =
    deps.dispatchChildTask ??
    (async (childTaskId, args) => {
      // Placeholder for MCP-only tests: leaves the child row in
      // TASK_STATE_SUBMITTED. A misconfigured production wire surfaces
      // here as a noisy warning rather than silently dropping children.
      console.warn(
        `[VOS-89] dispatchChildTask placeholder invoked: childTaskId=${childTaskId} agent=${args.agentName}`,
      );
    });

  const mcp = new McpServer({ name: "void-os", version: pkg.version });

  mcp.registerTool(
    "vault.read",
    vaultReadDef,
    makeVaultRead({ vaultRoot, db }) as never,
  );
  mcp.registerTool(
    "ask_user",
    askUserDef,
    makeAskUser({ bridge }) as never,
  );
  mcp.registerTool(
    "ask_agent",
    askAgentDef,
    makeAskAgent({
      db,
      bus,
      loadAgentDefn,
      dispatchChildTask,
      now: () => Date.now(),
    }) as never,
  );

  return mcp.server;
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
