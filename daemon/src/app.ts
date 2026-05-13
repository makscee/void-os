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
 * WebSocket handler for /events. Exported so tests can mount it via
 * `Bun.serve({ websocket: wsHandler, ... })` without spawning the daemon.
 *
 * Wire protocol v1:
 *   open      → server sends {type:"hello", version:"<semver>"}
 *   ping      → server replies {type:"pong"}
 *   unknown   → server ignores (no reply frame)
 */
export const wsHandler: WebSocketHandler<unknown> = {
  open(ws: ServerWebSocket<unknown>) {
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
  close() {
    /* noop */
  },
};
