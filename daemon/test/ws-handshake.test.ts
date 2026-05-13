/**
 * VOS-78 T8: daemon WebSocket handshake — hello frame + typed ping/pong.
 *
 * Boot pattern (a): buildApp factory + local Bun.serve({ port: 0 }) — same
 * shape as test/mcp-mount.test.ts. WebSocket handler is exported from
 * src/app.ts as `wsHandler` so test and src/index.ts share one source of
 * truth (no inline duplication, no third boot pattern).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import { buildApp, VERSION, wsHandler } from "../src/app.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Ctx {
  vaultRoot: string;
  db: Database;
  server: any;
  url: string;
}

function startServer(): Ctx {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-ws-"));
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
  const url = `ws://127.0.0.1:${server.port}/events`;
  return { vaultRoot, db, server, url };
}

/**
 * Open a WebSocket, collect text frames into an array. Resolves with the
 * collector and a `close()` helper after `frameCount` frames OR `timeoutMs`,
 * whichever comes first. Lets us assert "expected N frames, got M".
 */
function collect(
  url: string,
  frameCount: number,
  timeoutMs: number,
): Promise<{ frames: string[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: string[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ frames, ws });
    };
    ws.addEventListener("error", (e) => {
      if (!done) reject(new Error(`ws error: ${String(e)}`));
    });
    ws.addEventListener("message", (ev) => {
      frames.push(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (frames.length >= frameCount) finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

describe("VOS-78 daemon WS handshake (/events)", () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = startServer(); });
  afterEach(() => { ctx.server.stop(true); });

  test("first frame is {type:'hello', version:<semver>}", async () => {
    const { frames, ws } = await collect(ctx.url, 1, 1000);
    ws.close();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const hello = JSON.parse(frames[0]!) as { type: string; version: string };
    expect(hello.type).toBe("hello");
    expect(hello.version).toBe(VERSION);
    expect(hello.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("client sends {type:'ping'} → server replies {type:'pong'}", async () => {
    // Single message listener for the whole test, push every frame.
    const ws = new WebSocket(ctx.url);
    const frames: string[] = [];
    ws.addEventListener("message", (ev) => {
      frames.push(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    // Wait for hello.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for hello")), 1000);
      const tick = () => {
        if (frames.length >= 1) { clearTimeout(t); resolve(); }
        else setTimeout(tick, 10);
      };
      tick();
    });
    ws.send(JSON.stringify({ type: "ping" }));
    // Wait for pong (frames.length === 2) or timeout.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      const tick = () => {
        if (frames.length >= 2) { clearTimeout(t); resolve(); }
        else setTimeout(tick, 10);
      };
      tick();
    });
    ws.close();
    expect(frames.length).toBe(2);
    const pong = JSON.parse(frames[1]!) as { type: string };
    expect(pong.type).toBe("pong");
  });

  test("client sends unknown frame → server emits no additional frame", async () => {
    const ws = new WebSocket(ctx.url);
    const frames: string[] = [];
    ws.addEventListener("message", (ev) => {
      frames.push(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    // Wait for hello.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for hello")), 1000);
      const tick = () => {
        if (frames.length >= 1) { clearTimeout(t); resolve(); }
        else setTimeout(tick, 10);
      };
      tick();
    });
    // Send a frame the daemon does not know about.
    ws.send(JSON.stringify({ type: "chat.message", text: "hi" }));
    // Wait long enough that any reply would have arrived.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    ws.close();
    // Only the hello frame should have been received.
    expect(frames.length).toBe(1);
    const hello = JSON.parse(frames[0]!) as { type: string };
    expect(hello.type).toBe("hello");
  });
});
