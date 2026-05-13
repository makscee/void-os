/**
 * void-os daemon entry point.
 *
 * Bun + Hono HTTP server with WebSocket upgrade on :7777.
 * Thin: build app, start server.
 */

import type { ServerWebSocket } from "bun";
import { buildApp, VERSION } from "./app.ts";

const PORT = Number(process.env.VOID_OS_PORT ?? 7777);
const HOST = process.env.VOID_OS_HOST ?? "127.0.0.1";

const app = buildApp();

// Bun.serve handles WS upgrade natively. Route /events through the upgrade
// path; everything else falls through to Hono's fetch.
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/events") {
      if (srv.upgrade(req)) return; // upgraded, response handled by ws
      return new Response("expected WebSocket upgrade", { status: 426 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws: ServerWebSocket<unknown>) {
      ws.send(JSON.stringify({ type: "hello", version: VERSION }));
    },
    message(ws: ServerWebSocket<unknown>, msg: string | Buffer) {
      // Echo for now. Real event multiplexing arrives with events module.
      ws.send(typeof msg === "string" ? msg : msg.toString());
    },
    close() {
      /* noop */
    },
  },
});

console.log(`void-os daemon v${VERSION} listening on http://${server.hostname}:${server.port}`);
