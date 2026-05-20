import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createEventBus } from "../src/events/index.ts";
import { runMigrationsFromDir } from "../src/adapters/sqlite/migrations";

const TOKEN = "test-token";
const MIGRATIONS_DIR = join(__dirname, "..", "src", "adapters", "sqlite", "migrations");

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  vaultRoot: string;
  db: Database;
  bus: ReturnType<typeof createEventBus>;
}
let ctx: Ctx;

beforeEach(async () => {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cs-"));
  const bus = createEventBus();
  const app = await buildApp({ db, vaultRoot, token: TOKEN, bootTime: Date.now(), eventBus: bus });
  // Seed a chat row so route can find it.
  db.run("INSERT INTO contexts (id, title, created_at) VALUES ('c1',null,1)");
  ctx = { app, vaultRoot, db, bus };
});

afterEach(() => {
  fs.rmSync(ctx.vaultRoot, { recursive: true, force: true });
});

async function readSSE(res: Response, frameCount: number, timeoutMs = 2000): Promise<string[]> {
  const frames: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (frames.length < frameCount && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>(r => setTimeout(() => r({ value: undefined, done: true }), 100)),
    ]);
    if (done) break;
    buf += decoder.decode(value!, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      frames.push(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  return frames;
}

test("missing token → 401", async () => {
  const res = await ctx.app.request("/chat/c1/stream");
  expect(res.status).toBe(401);
});

test("unknown chat → 404", async () => {
  const res = await ctx.app.request("/chat/nope/stream?token=" + TOKEN);
  expect(res.status).toBe(404);
});

test("hello frame first, closes on run_end", async () => {
  const before = ctx.bus.listenerCount();

  const resPromise = ctx.app.request("/chat/c1/stream?token=" + TOKEN);
  // Give the route a beat to subscribe.
  await new Promise(r => setTimeout(r, 20));
  const res = await resPromise;
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  // Wait a tick for subscribe to settle.
  await new Promise(r => setTimeout(r, 20));
  expect(ctx.bus.listenerCount()).toBe(before + 1);

  // Emit a text and a run_end for c1.
  ctx.bus.emit({ type: "text", chatId: "c1", runId: "r1", payload: { delta: "hi" } });
  ctx.bus.emit({ type: "run.end", chatId: "c1", runId: "r1", payload: { status: "ok" } });

  const frames = await readSSE(res, 3);
  // Frame 0 = hello, frame 1 = text, frame 2 = run_end.
  expect(frames[0]).toContain("event: hello");
  expect(frames[1]).toContain("event: text");
  expect(frames[2]).toContain("event: run_end");

  // After run_end, server closed → listener gone.
  await new Promise(r => setTimeout(r, 50));
  expect(ctx.bus.listenerCount()).toBe(before);
});

test("events for OTHER chats are not delivered", async () => {
  ctx.db.run("INSERT INTO contexts (id, title, created_at) VALUES ('c2',null,1)");
  const resPromise = ctx.app.request("/chat/c1/stream?token=" + TOKEN);
  await new Promise(r => setTimeout(r, 20));
  const res = await resPromise;
  ctx.bus.emit({ type: "text", chatId: "c2", runId: "r2", payload: { delta: "noise" } });
  ctx.bus.emit({ type: "text", chatId: "c1", runId: "r1", payload: { delta: "real" } });
  ctx.bus.emit({ type: "run.end", chatId: "c1", runId: "r1", payload: { status: "ok" } });

  const frames = await readSSE(res, 3);
  expect(frames.find(f => f.includes("noise"))).toBeUndefined();
  expect(frames.find(f => f.includes("real"))).toBeDefined();
});

test("client disconnect unsubscribes (no listener leak)", async () => {
  const before = ctx.bus.listenerCount();
  const resP = ctx.app.request("/chat/c1/stream?token=" + TOKEN);
  await new Promise(r => setTimeout(r, 20));
  const res = await resP;
  await new Promise(r => setTimeout(r, 20));
  expect(ctx.bus.listenerCount()).toBe(before + 1);
  // Cancel the response stream — this is how Hono detects client disconnect
  // when using app.request() (no real socket). The cancel propagates to
  // StreamingApi which fires abortSubscribers, including our onAbort.
  await res.body!.cancel();
  // Hono's onAbort fires synchronously from cancel; give the close()
  // chain one tick to unwind.
  await new Promise(r => setTimeout(r, 50));
  expect(ctx.bus.listenerCount()).toBe(before);
});
