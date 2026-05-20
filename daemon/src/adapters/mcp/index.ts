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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pkg from "../../../package.json" with { type: "json" };
import type { EventBus } from "../../events/index.ts";
import type { AgentDefn, PermissionEngine } from "../../permissions/engine.ts";
import type { VaultWriter } from "../../vault/writer.ts";
import type { AskUserBridge } from "../../chat/ask-user-bridge.ts";
import { honoBridge } from "./hono-bridge.ts";
import { vaultReadDef, makeVaultRead } from "./tools/vault-read.ts";
import { vaultCreateDef, makeVaultCreate } from "./tools/vault-create.ts";
import { vaultAppendDef, makeVaultAppend } from "./tools/vault-append.ts";
import { vaultReplaceSectionDef, makeVaultReplaceSection } from "./tools/vault-replace-section.ts";
import { vaultSetPropertyDef, makeVaultSetProperty } from "./tools/vault-set-property.ts";
import { vaultPatchDef, makeVaultPatch } from "./tools/vault-patch.ts";
import { vaultDeleteDef, makeVaultDelete } from "./tools/vault-delete.ts";
import { vaultMoveDef, makeVaultMove } from "./tools/vault-move.ts";
import { vaultLoadTemplateDef, makeVaultLoadTemplate } from "./tools/vault-load-template.ts";
import { askUserDef, makeAskUser } from "./tools/ask-user.ts";
import { askAgentDef, makeAskAgent } from "./tools/ask-agent.ts";
import { listTasksDef, makeListTasks } from "./tools/list-tasks.ts";
import { listChildrenDef, makeListChildren } from "./tools/list-children.ts";
import { getTaskDef, makeGetTask } from "./tools/get-task.ts";
import { completeTaskDef, makeCompleteTask } from "./tools/complete-task.ts";
import type { HandoffLog } from "../../agents/handoff-log.ts";

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
  /**
   * VOS-91 T3: WS fan-out helper. Production buildApp defaults to broadcast();
   * tests inject a spy to assert on WS-bound envelopes. Mirrors
   * orchestrator's deps.emit pattern.
   */
  emit?: (type: string, payload: Record<string, unknown>) => void;
  // VOS-106: permission engine for the vault.read scope gate. The calling
  // agent identity is resolved per-request from the `?agent=<name>` URL
  // query in mountMcp, then threaded into buildMcpServer.
  engine: PermissionEngine;
  /**
   * VOS-108: shared VaultWriter singleton for vault.create/append/replace_section/
   * set_property/patch/delete/move. Built once in app.ts (mutex + atomic-write state
   * is per-instance, so all tools MUST share one instance).
   */
  writer: VaultWriter;
  /**
   * VOS-154: optional handoff-log adapter. Production app.ts builds from env
   * (VOID_OS_HL_PATH + VOID_OS_HL_HUB_ROOT) so every ask_agent dispatch leaves
   * a provenance entry. Tests/smoke omit this and ask_agent falls back to the
   * NULL_HANDOFF_LOG no-op.
   */
  handoffLog?: HandoffLog;
  /** VOS-154: orchestrator session id threaded into handoff entries. */
  sessionId?: string | null;
  /** VOS-154: milestone slug threaded into handoff entries. */
  milestone?: string | null;
}

/**
 * VOS-145: shape of the parsed `agent_cards.card_json` payload (all fields
 * `unknown` so the helper can defensively validate before casting).
 */
export interface AgentDefnCard {
  name?: unknown;
  read_scope?: unknown;
  write_scope?: unknown;
  ask_agent_allow?: unknown;
  tools?: unknown;
  network?: unknown;
  posture?: unknown;
}

/**
 * VOS-145: pure card-validation helper. Lifted out of `defaultLoadAgentDefn`
 * so it can be unit-tested without the sqlite round-trip. Validates the
 * new `network` + `posture` fields and rejects bogus values with a clear
 * error. All existing field-reads (ask_agent_allow, read_scope, write_scope,
 * tools) are preserved with their original `Array.isArray` defensive checks.
 */
export function validateAgentDefnCard(card: AgentDefnCard, fallbackName: string): AgentDefn {
  const name = typeof card.name === "string" && card.name.length > 0 ? card.name : fallbackName;

  const network = card.network;
  if (network !== undefined && network !== "none" && network !== "allow") {
    throw new Error(
      `agent ${name}: 'network' must be 'none' or 'allow' (got ${JSON.stringify(network)})`,
    );
  }

  const posture = card.posture;
  if (
    posture !== undefined &&
    posture !== "read-only" &&
    posture !== "workspace-write" &&
    posture !== "open"
  ) {
    throw new Error(
      `agent ${name}: 'posture' must be 'read-only', 'workspace-write', or 'open' (got ${JSON.stringify(posture)})`,
    );
  }

  const defn: AgentDefn = { name };
  if (Array.isArray(card.ask_agent_allow)) {
    defn.ask_agent_allow = card.ask_agent_allow as string[];
  }
  if (Array.isArray(card.read_scope)) {
    defn.read_scope = card.read_scope as string[];
  }
  if (Array.isArray(card.write_scope)) {
    defn.write_scope = card.write_scope as string[];
  }
  // VOS-122 F7: declared tool allowlist (sourced from agent.md frontmatter
  // `tools:`). Absent => legacy permissive path in the CC spawner.
  if (Array.isArray(card.tools)) {
    defn.tools = (card.tools as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
  }
  if (network !== undefined) {
    defn.network = network;
  }
  if (posture !== undefined) {
    defn.posture = posture;
  }
  return defn;
}

/**
 * VOS-89 T10: default AgentDefn loader — reads `agent_cards.card_json`
 * and parses it. The card JSON is expected to carry at least `name`;
 * `ask_agent_allow` is optional, and when absent the field is left
 * `undefined` (NOT empty array), which the permission gate in
 * ask_agent treats as permissive at the agent level.
 *
 * VOS-145: card validation extracted to `validateAgentDefnCard` (pure helper).
 */
export function defaultLoadAgentDefn(db: Database, agentName: string): AgentDefn {
  const row = db
    .query("SELECT card_json FROM agent_cards WHERE agent_name = ?")
    .get(agentName) as { card_json: string } | undefined;
  if (!row) {
    throw new Error(`unknown agent: ${agentName}`);
  }
  const card = JSON.parse(row.card_json) as AgentDefnCard;
  return validateAgentDefnCard(card, agentName);
}

export function buildMcpServer(deps: McpDeps & { callingAgent: AgentDefn }): McpServer {
  const { vaultRoot, db, bus, bridge, engine, callingAgent, emit, writer } = deps;
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

  // VOS-167: McpServer.registerTool's generic inference over each tool's
  // ZodRawShape `inputSchema` explodes into TS2589 ("excessively deep, possibly
  // infinite") — which OOMs tsc outright. Bind the method through a loosened
  // signature; the `*Def` + handler shapes are already validated at each tool
  // module's own boundary (handlers were already passed `as never`).
  const registerTool = mcp.registerTool.bind(mcp) as (
    name: string,
    def: unknown,
    handler: unknown,
  ) => void;

  registerTool(
    "vault.read",
    vaultReadDef,
    makeVaultRead({ vaultRoot, db, engine, agent: callingAgent }) as never,
  );

  const writeDeps = { vaultRoot, db, engine, writer, agent: callingAgent };

  registerTool("vault.create",          vaultCreateDef,         makeVaultCreate(writeDeps) as never);
  registerTool("vault.append",          vaultAppendDef,         makeVaultAppend(writeDeps) as never);
  registerTool("vault.replace_section", vaultReplaceSectionDef, makeVaultReplaceSection(writeDeps) as never);
  registerTool("vault.set_property",    vaultSetPropertyDef,    makeVaultSetProperty(writeDeps) as never);
  registerTool("vault.patch",           vaultPatchDef,          makeVaultPatch(writeDeps) as never);
  registerTool("vault.delete",          vaultDeleteDef,         makeVaultDelete(writeDeps) as never);
  registerTool("vault.move",            vaultMoveDef,           makeVaultMove(writeDeps) as never);

  // VOS-131: read-only template loader. No scope gate — templates are
  // intentionally world-readable inside the vault; the gate that matters is
  // on the subsequent vault.create the agent issues with the rendered output.
  registerTool(
    "vault.load_template",
    vaultLoadTemplateDef,
    makeVaultLoadTemplate({ vaultRoot }) as never,
  );

  registerTool(
    "ask_user",
    askUserDef,
    makeAskUser({ bridge }) as never,
  );
  registerTool(
    "ask_agent",
    askAgentDef,
    makeAskAgent({
      db,
      bus,
      loadAgentDefn,
      dispatchChildTask,
      now: () => Date.now(),
      emit,
      handoffLog: deps.handoffLog,
      sessionId: deps.sessionId,
      milestone: deps.milestone,
    }) as never,
  );
  // VOS-171: agent-declared terminal state. Targets `_meta.task_id` (the
  // calling agent's own Task) — never a foreign id, so a parent cannot
  // force-complete a child through it.
  registerTool(
    "complete_task",
    completeTaskDef,
    makeCompleteTask({ db, emit }) as never,
  );

  // VOS-169: navigation queries. Read-only walks over the perpetual tree of
  // Tasks — the managing agent and the activity-list UI consume the same
  // primitives, so navigation never drifts from a bespoke API.
  registerTool("list_tasks",    listTasksDef,    makeListTasks({ db }) as never);
  registerTool("list_children", listChildrenDef, makeListChildren({ db }) as never);
  registerTool("get_task",      getTaskDef,      makeGetTask({ db }) as never);

  return mcp;
}

export function mountMcp(app: Hono, deps: McpDeps): void {
  const loadAgentDefn =
    deps.loadAgentDefn ?? ((name: string) => defaultLoadAgentDefn(deps.db, name));
  app.all("/mcp", async (c) => {
    // VOS-106: calling-agent identity travels in the URL query. The
    // spawner emits `?agent=<name>` per spawn-settings (the URL is kept
    // stable across runs so CC's MCP client doesn't re-fetch tool defs
    // every turn and bust the Anthropic prompt cache). We resolve the
    // AgentDefn here and pass it into buildMcpServer so tools (currently
    // vault.read) can apply per-agent scope gates.
    const agentName = c.req.query("agent");
    if (!agentName) {
      return c.json({ error: "MISSING_AGENT_QUERY: /mcp requires ?agent=<name>" }, 400);
    }
    let callingAgent: AgentDefn;
    try {
      callingAgent = loadAgentDefn(agentName);
    } catch {
      return c.json({ error: `UNKNOWN_AGENT: ${agentName}` }, 400);
    }

    const mcp = buildMcpServer({ ...deps, callingAgent });
    // Stateless mode: each request gets a fresh server+transport. Setting
    // sessionIdGenerator to undefined disables session tracking; otherwise
    // the SDK requires clients to echo back an mcp-session-id, which can't
    // work when every request lands on a brand-new transport instance.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,  // VOS-112: return single JSON envelope so the stdio bridge can parse with .json().
    });
    await mcp.server.connect(transport);

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
