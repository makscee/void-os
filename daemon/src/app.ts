/**
 * Build the Hono app with all routes mounted.
 *
 * Split from index.ts so tests can drive `app.fetch` directly without
 * spinning up Bun.serve / binding a port.
 */

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import pkg from "../package.json" with { type: "json" };
import { mountApi } from "./api/index.ts";
import { chatsApi } from "./api/chats.ts";
import { chatApi } from "./api/chat.ts";
import { mountMcp } from "./adapters/mcp/index.ts";

export const VERSION = pkg.version;

export interface BuildAppDeps {
  db: Database;
  vaultRoot: string;
}

export const buildApp = (deps: BuildAppDeps): Hono => {
  const app = new Hono();
  app.get("/", (c) => c.text(`void-os daemon v${VERSION}\n`));
  mountApi(app, { version: VERSION });
  // VOS-79: chat-lifecycle HTTP surface. `chatsApi` owns list/create;
  // `chatApi` owns per-chat routes (GET /chat/:id today, /messages and
  // POST /chat/:id/message land in T4 and T9).
  app.route("/", chatsApi(deps.db));
  app.route("/", chatApi(deps.db));
  mountMcp(app, { vaultRoot: deps.vaultRoot, db: deps.db });
  return app;
};

/**
 * VOS-79 T9: connected /events sockets + broadcast() fan-out.
 *
 * Shared module-level Set so wsHandler (open/close) and broadcast (orchestrator
 * emit shim) reference the same client roster. One daemon process owns one
 * roster; tests that boot multiple servers in-process share it too, which is
 * fine — broadcasts are typed envelopes, not per-server state.
 *
 * Envelope shape: `{type, ts: <epoch ms>, ...payload}`. `payload` keys take
 * precedence over the wrapper (so `chat_id`, `run_id`, etc. land at top level).
 */
const sockets = new Set<ServerWebSocket<unknown>>();

export const broadcast = (
  type: string,
  payload: Record<string, unknown> = {},
): void => {
  const msg = JSON.stringify({ type, ts: Date.now(), ...payload });
  for (const ws of sockets) {
    try { ws.send(msg); } catch { /* socket dead — close handler will drain */ }
  }
};

/**
 * Test-only: drop all connected sockets without sending anything. Real wire
 * closes happen via the `close` handler. Used by tests that share the module
 * to avoid cross-test bleed.
 */
export const _resetBroadcastSockets = (): void => {
  sockets.clear();
};

/**
 * WebSocket handler for /events. Exported so tests can mount it via
 * `Bun.serve({ websocket: wsHandler, ... })` without spawning the daemon.
 *
 * Wire protocol v1:
 *   open      → server sends {type:"hello", version:"<semver>"}; socket joins
 *               the broadcast set so it receives subsequent broadcast() frames.
 *   ping      → server replies {type:"pong"}
 *   unknown   → server ignores (no reply frame)
 *   close     → socket leaves the broadcast set
 */
export const wsHandler: WebSocketHandler<unknown> = {
  open(ws: ServerWebSocket<unknown>) {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "hello", version: VERSION }));
  },
  message(ws: ServerWebSocket<unknown>, msg: string | Buffer) {
    const text = typeof msg === "string" ? msg : msg.toString();
    let parsed: { type?: unknown } | undefined;
    try { parsed = JSON.parse(text) as { type?: unknown }; } catch { return; }
    if (parsed?.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    // unknown type: ignore in v1
  },
  close(ws: ServerWebSocket<unknown>) {
    sockets.delete(ws);
  },
};
