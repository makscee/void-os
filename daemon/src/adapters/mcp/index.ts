/**
 * void-os MCP server. Exposes daemon ops as MCP tools over Streamable HTTP at /mcp.
 *
 * Mount via `mountMcp(app, { vaultRoot, db, bus })`. Per request we create a fresh
 * StreamableHTTPServerTransport (stateless mode) and dispatch through the
 * Hono↔SDK bridge.
 *
 * VOS-88 T7: ask_user is registered here. MCP is stateless (fresh
 * Server+transport per request), so per-session context cannot be attached
 * to the transport. The caller's runtime MUST inject `task_id` (and optional
 * `context_id`, `run_id`) into the ask_user tool `arguments` themselves; we
 * read them off `args` before invoking runAskUser.
 *
 * PendingRegistry is created ONCE at module scope so it is shared between
 * the MCP CallTool handler (which awaits answers) and the T8 HTTP route
 * (which resolves them). Both surfaces import `pendingRegistry` from this
 * module.
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
import type { EventBus } from "../../events/index.ts";
import type { AgentDefn } from "../../permissions/engine.ts";
import { honoBridge } from "./hono-bridge.ts";
import { handleVaultRead, vaultReadDef } from "./tools/vault-read.ts";
import { ASK_USER_TOOL_DEF, runAskUser } from "./tools/ask-user.ts";
import { ASK_AGENT_TOOL_DEF } from "./tools/ask-agent-def.ts";
import { runAskAgent, type AskAgentArgs } from "./tools/ask-agent.ts";
import {
  createPendingRegistry,
  type PendingRegistry,
} from "./pending-questions.ts";

export interface McpDeps {
  vaultRoot: string;
  db: Database;
  bus: EventBus;
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
 * VOS-89 T10: Static MCP tool list. Exported so tests (and any future
 * tools/list shaping logic) can inspect the canonical schema without
 * spinning up a Server. The `setRequestHandler(ListToolsRequestSchema)`
 * call below returns this exact array.
 */
export function listMcpTools() {
  return [vaultReadDef, ASK_USER_TOOL_DEF, ASK_AGENT_TOOL_DEF];
}

/**
 * VOS-89 T10: default AgentDefn loader — reads `agent_cards.card_json`
 * and parses it. The card JSON is expected to carry at least `name`;
 * `ask_agent_allow` is optional, and when absent the field is left
 * `undefined` (NOT empty array), which the permission gate in
 * runAskAgent treats as permissive at the agent level.
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

// VOS-88 T7: module-scope singleton. Shared by the ask_user CallTool handler
// (await) and the T8 POST /chat/:id/answer route (resolve). Exported as
// `pendingRegistry` for T8 to import directly.
export const pendingRegistry: PendingRegistry = createPendingRegistry();

const ASK_USER_DEADLINE_MS = 30 * 60 * 1000;

export function buildMcpServer(deps: McpDeps): Server {
  const server = new Server(
    { name: "void-os", version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listMcpTools(),
  }));

  // Resolve the AgentDefn loader + child-task dispatcher. Production
  // buildApp injects both; tests for the MCP layer in isolation can omit
  // either and fall through to the defaults.
  const loadAgentDefn =
    deps.loadAgentDefn ?? ((name: string) => defaultLoadAgentDefn(deps.db, name));
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

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    if (name === "vault.read") {
      const res = await handleVaultRead(args as { path: string }, { vaultRoot: deps.vaultRoot, db: deps.db });
      return res as unknown as CallToolResult;
    }
    if (name === "ask_user") {
      // MCP is stateless: there is no per-session task context on the
      // transport. The caller injects task_id / context_id / run_id into
      // the tool arguments. zod's AskUserInput is non-strict and ignores
      // these extras; we read them separately before invoking runAskUser.
      const a = (args ?? {}) as Record<string, unknown>;
      const taskId = typeof a.task_id === "string" ? a.task_id : undefined;
      if (!taskId) {
        return {
          isError: true,
          content: [{ type: "text", text: "ASK_USER_MISSING_TASK_ID" }],
        };
      }
      const contextId = typeof a.context_id === "string" ? a.context_id : taskId;
      const runId = typeof a.run_id === "string" ? a.run_id : null;
      const res = await runAskUser(
        {
          db: deps.db,
          bus: deps.bus,
          pending: pendingRegistry,
          taskId,
          contextId,
          runId,
          deadlineMs: ASK_USER_DEADLINE_MS,
          now: () => Date.now(),
        },
        args,
      );
      return res as unknown as CallToolResult;
    }
    if (name === "ask_agent") {
      // VOS-89 T10: like ask_user, MCP is stateless — caller's runtime must
      // inject task_id / context_id into the tool arguments. We strip them
      // off before forwarding the typed AskAgentArgs to runAskAgent.
      const a = (args ?? {}) as Record<string, unknown>;
      const taskId = typeof a.task_id === "string" ? a.task_id : undefined;
      if (!taskId) {
        return {
          isError: true,
          content: [{ type: "text", text: "ASK_AGENT_MISSING_TASK_ID" }],
        };
      }
      const contextId = typeof a.context_id === "string" ? a.context_id : taskId;
      const res = await runAskAgent(
        {
          db: deps.db,
          bus: deps.bus,
          taskId,
          contextId,
          loadAgentDefn,
          dispatchChildTask,
          now: () => Date.now(),
        },
        {
          target_agent_id: String(a.target_agent_id ?? ""),
          message: String(a.message ?? ""),
          system_message:
            typeof a.system_message === "string" ? a.system_message : undefined,
        } satisfies AskAgentArgs,
      );
      return res as unknown as CallToolResult;
    }
    return { isError: true, content: [{ type: "text", text: `UNKNOWN_TOOL: ${name}` }] };
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
