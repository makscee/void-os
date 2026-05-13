/**
 * VOS-79 T9: WS broadcaster fan-out integration.
 *
 * Verifies that calling `broadcast(type, payload)` (the orchestrator emit
 * shim) delivers a JSON envelope to every connected `/events` client.
 *
 * Boot pattern matches test/ws-handshake.test.ts (T8/VOS-78): buildApp +
 * local Bun.serve({ port: 0 }) so we don't bind a real port.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import {
  buildApp,
  VERSION,
  wsHandler,
  broadcast,
  _resetBroadcastSockets,
} from "../../src/app.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql.
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Ctx { vaultRoot: string; db: Database; server: any; url: string }

function startServer(): Ctx {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-wsbc-"));
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const app = buildApp({ db, vaultRoot });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch(req: Request, srv: any) {
      const u = new URL(req.url);
      if (u.pathname === "/events") {
        if (srv.upgrade(req)) return;
        return new Response("expected WebSocket upgrade", { status: 426 });
      }
      return app.fetch(req);
    },
    websocket: wsHandler,
  });
  return { vaultRoot, db, server, url: `ws://127.0.0.1:${server.port}/events` };
}

/** Open a WS, wait for the hello frame, return a frame collector + close fn. */
async function connect(url: string): Promise<{
  ws: WebSocket;
  frames: string[];
  waitFor: (n: number, timeoutMs: number) => Promise<void>;
}> {
  const ws = new WebSocket(url);
  const frames: string[] = [];
  ws.addEventListener("message", (ev) => {
    frames.push(typeof ev.data === "string" ? ev.data : String(ev.data));
  });
  // Wait for hello (first frame).
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for hello")), 1000);
    const tick = () => {
      if (frames.length >= 1) { clearTimeout(t); resolve(); }
      else setTimeout(tick, 5);
    };
    tick();
  });
  const waitFor = (n: number, timeoutMs: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      const tick = () => {
        if (frames.length >= n) { clearTimeout(t); resolve(); }
        else setTimeout(tick, 5);
      };
      tick();
    });
  return { ws, frames, waitFor };
}

describe("VOS-79 WS broadcaster fans bus events to /events clients", () => {
  let ctx: Ctx;
  beforeEach(() => {
    _resetBroadcastSockets();
    ctx = startServer();
  });
  afterEach(() => {
    ctx.server.stop(true);
    _resetBroadcastSockets();
  });

  test("connected client receives broadcast envelope after hello", async () => {
    const { ws, frames, waitFor } = await connect(ctx.url);
    // Hello received. Now drive a broadcast.
    broadcast("chat.token", { chat_id: "c1", run_id: "r1", delta: "Hi" });
    await waitFor(2, 1000);
    ws.close();
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const hello = JSON.parse(frames[0]!) as { type: string; version: string };
    expect(hello.type).toBe("hello");
    expect(hello.version).toBe(VERSION);
    const evt = JSON.parse(frames[1]!) as {
      type: string; chat_id: string; run_id: string; delta: string; ts: number;
    };
    expect(evt.type).toBe("chat.token");
    expect(evt.chat_id).toBe("c1");
    expect(evt.run_id).toBe("r1");
    expect(evt.delta).toBe("Hi");
    expect(typeof evt.ts).toBe("number");
    expect(evt.ts).toBeGreaterThan(0);
  });

  test("ordered fan-out of full chat lifecycle envelope sequence", async () => {
    const { ws, frames, waitFor } = await connect(ctx.url);
    broadcast("chat.message_user", { chat_id: "c1", run_id: "r1", text: "say hi" });
    broadcast("run.start", { chat_id: "c1", run_id: "r1", agent: "maya" });
    broadcast("chat.token", { chat_id: "c1", run_id: "r1", delta: "Hi" });
    broadcast("chat.completion", { chat_id: "c1", run_id: "r1" });
    broadcast("run.end", { chat_id: "c1", run_id: "r1", status: "done" });
    // 5 broadcasts + hello = 6 frames.
    await waitFor(6, 1000);
    ws.close();
    expect(frames).toHaveLength(6);
    const types = frames.slice(1).map((f) => (JSON.parse(f) as { type: string }).type);
    expect(types).toEqual([
      "chat.message_user",
      "run.start",
      "chat.token",
      "chat.completion",
      "run.end",
    ]);
  });

  test("multiple connected clients all receive the same envelope", async () => {
    const a = await connect(ctx.url);
    const b = await connect(ctx.url);
    broadcast("chat.token", { chat_id: "c1", run_id: "r1", delta: "x" });
    await a.waitFor(2, 1000);
    await b.waitFor(2, 1000);
    a.ws.close();
    b.ws.close();
    expect(a.frames).toHaveLength(2);
    expect(b.frames).toHaveLength(2);
    const aEvt = JSON.parse(a.frames[1]!) as { type: string; delta: string };
    const bEvt = JSON.parse(b.frames[1]!) as { type: string; delta: string };
    expect(aEvt).toMatchObject({ type: "chat.token", delta: "x" });
    expect(bEvt).toMatchObject({ type: "chat.token", delta: "x" });
  });

  test("closed client no longer receives broadcasts", async () => {
    const { ws, frames, waitFor } = await connect(ctx.url);
    ws.close();
    // Give the server time to process close + remove from socket set.
    await new Promise<void>((r) => setTimeout(r, 100));
    broadcast("chat.token", { chat_id: "c1", run_id: "r1", delta: "ghost" });
    await waitFor(2, 250); // resolves on timeout — no second frame expected.
    expect(frames).toHaveLength(1); // only the hello before close
  });

  test("envelope payload keys override wrapper (top-level chat_id, run_id)", async () => {
    const { ws, frames, waitFor } = await connect(ctx.url);
    broadcast("chat.tool_call", {
      chat_id: "c9",
      run_id: "r9",
      tool: "Read",
      input: { path: "/a.md" },
    });
    await waitFor(2, 1000);
    ws.close();
    const evt = JSON.parse(frames[1]!) as Record<string, unknown>;
    expect(evt.type).toBe("chat.tool_call");
    expect(evt.chat_id).toBe("c9");
    expect(evt.run_id).toBe("r9");
    expect(evt.tool).toBe("Read");
    expect((evt.input as { path: string }).path).toBe("/a.md");
  });
});
