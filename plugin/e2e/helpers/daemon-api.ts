// VOS-127 T2 — shared daemon-API helpers for plugin/e2e specs.
//
// Loose functions (not a typed client class — protocol package owns HTTP
// shapes, this module would be a second source of truth otherwise). Each
// spec currently rolls its own copy of these four primitives inline; that
// duplication is what VOS-127 collapses.
//
// Patterns lifted verbatim from sibling specs:
//   * mintChat / sendMessage  ← chat-list-polish.spec.ts, cost-meter.spec.ts
//   * openEventsWs            ← ask-agent.spec.ts (and -nested/-subthread/-reload)
//   * callAskAgentOverMcp     ← ask-agent.spec.ts (and siblings)
//
// REST takes a Playwright `APIRequestContext` (bound to the daemon's base
// URL by the spec). WS + MCP take the raw `port` number — both open their
// own connections directly. This matches every existing call site.
//
// Trap 3 (WS-before-send): `openEventsWs` opens the socket and starts
// buffering frames immediately, so specs MUST construct the helper BEFORE
// triggering the action that produces the frame they want to wait for.
// Both `waitFor` and `close` are explicit on the returned handle.

import { expect, type APIRequestContext } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * POST /chats with `{agent}` body. Asserts 200 and returns the new chat id.
 *
 * Note the field name is `agent`, NOT `agent_name` — verified in T9 of
 * VOS-107 (see cost-meter.spec.ts header).
 */
export async function mintChat(
  api: APIRequestContext,
  agent: string,
): Promise<{ chatId: string }> {
  const res = await api.post("/chats", { data: { agent } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBeTruthy();
  return { chatId: body.id };
}

/**
 * POST /chat/:id/message with `{text}` body. Accepts 200/201/202.
 *
 * Awaiting blocks until the orchestrator's `dispatch` drains `run.end` —
 * i.e. by the time it returns, downstream subscribers (cost row writes,
 * etc.) have already fired. For fire-and-forget scenarios that park on
 * `vos_ask_user`, do NOT await this call; see chat-list-polish.spec.ts
 * for the unawaited variant.
 */
export async function sendMessage(
  api: APIRequestContext,
  chatId: string,
  text: string,
): Promise<void> {
  const res = await api.post(`/chat/${chatId}/message`, { data: { text } });
  expect([200, 201, 202]).toContain(res.status());
}

export interface EventsWsHandle {
  ws: WebSocket;
  waitFor: (
    predicate: (msg: Record<string, unknown>) => boolean,
    opts?: { timeoutMs?: number },
  ) => Promise<Record<string, unknown>>;
  close: () => void;
}

/**
 * Connect to the daemon's `/events` WebSocket at `ws://127.0.0.1:<port>/events`.
 *
 * Buffers every frame as it arrives; `waitFor` resolves with the first
 * frame matching `predicate`, scanning the already-arrived backlog first
 * and only then registering a listener for future frames. Rejects after
 * `opts.timeoutMs` (default 10s).
 *
 * Open BEFORE you trigger the action you want to observe (trap 3 in the
 * void-os CLAUDE.md). Call `close()` from a `finally` block to release
 * the socket; nothing closes it implicitly.
 */
export function openEventsWs(
  port: number,
  _opts?: Record<string, never>,
): EventsWsHandle {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
  const queue: Record<string, unknown>[] = [];
  const listeners: Array<(msg: Record<string, unknown>) => void> = [];
  ws.addEventListener("message", (ev) => {
    let msg: Record<string, unknown>;
    try {
      const raw = typeof ev.data === "string" ? ev.data : (ev.data as { toString(): string }).toString();
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    queue.push(msg);
    for (const l of listeners.splice(0)) l(msg);
  });
  return {
    ws,
    waitFor(predicate, opts) {
      const timeoutMs = opts?.timeoutMs ?? 10_000;
      return new Promise((resolve, reject) => {
        const hit = queue.find(predicate);
        if (hit) return resolve(hit);
        const t = setTimeout(
          () => reject(new Error(`waitFor: timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
        const listener = (msg: Record<string, unknown>) => {
          if (predicate(msg)) {
            clearTimeout(t);
            resolve(msg);
          } else {
            listeners.push(listener);
          }
        };
        listeners.push(listener);
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Issue a real MCP `ask_agent` tool call against the daemon at
 * `http://127.0.0.1:<port>/mcp?agent=maya`. Mirrors
 * daemon/test/integration/ask-agent.test.ts: one fresh
 * `StreamableHTTPClientTransport` per call (stateless mode), client
 * closed in `finally`.
 *
 * `_meta` carries runtime ids (task_id, context_id, tool_call_id) per
 * VOS-97 ADR-0002; `arguments` carries only the agent-visible fields.
 * `tool_call_id` MUST match the originating `chat.tool_use` frame so the
 * ask_agent handler can correlate `parent_tool_call_id` on
 * `mintChildAndFlipParent`.
 */
export async function callAskAgentOverMcp(args: {
  port: number;
  taskId: string;
  contextId: string;
  targetAgentId: string;
  message: string;
  toolCallId: string;
}): Promise<unknown> {
  const client = new Client({ name: "vos127-e2e-helper", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    // VOS-106 T8: /mcp requires ?agent=<name> for calling-agent identity.
    // Caller here is maya (parent dispatching ask_agent to a child).
    new URL(`http://127.0.0.1:${args.port}/mcp?agent=maya`),
  );
  await client.connect(transport);
  try {
    return await client.callTool({
      name: "ask_agent",
      arguments: {
        target_agent_id: args.targetAgentId,
        message: args.message,
      },
      _meta: {
        task_id: args.taskId,
        context_id: args.contextId,
        tool_call_id: args.toolCallId,
      },
    });
  } finally {
    await client.close();
  }
}
