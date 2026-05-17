import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { buildApp } from "../src/app.ts";

interface Ctx { app: Awaited<ReturnType<typeof buildApp>>; vaultRoot: string }
let ctx: Ctx;
const TOKEN = "test-token";
const auth = { Authorization: `Bearer ${TOKEN}` };

beforeEach(async () => {
  const vaultRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-")));
  const db = new Database(":memory:");
  // Bare schema — vault routes don't touch DB but buildApp expects it.
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');`);
  const app = await buildApp({ db, vaultRoot, token: TOKEN, bootTime: Date.now() });
  ctx = { app, vaultRoot };
});

afterEach(() => {
  fs.rmSync(ctx.vaultRoot, { recursive: true, force: true });
});

test("GET /vault/file — read existing file", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "hi.md"), "# hello\n");
  const res = await ctx.app.request("/vault/file?path=hi.md", { headers: auth });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { path: string; content: string; size: number; mtime: number };
  expect(body.content).toBe("# hello\n");
  expect(body.size).toBe(8);
  expect(body.path).toBe(path.join(ctx.vaultRoot, "hi.md"));
});

test("GET /vault/file — missing path → 404 E_NOT_FOUND", async () => {
  const res = await ctx.app.request("/vault/file?path=nope.md", { headers: auth });
  expect(res.status).toBe(404);
  expect((await res.json() as any).error).toBe("E_NOT_FOUND");
});

test("GET /vault/file — traversal → 403 E_OUT_OF_SCOPE", async () => {
  const res = await ctx.app.request("/vault/file?path=../../etc/passwd", { headers: auth });
  expect(res.status).toBe(403);
  expect((await res.json() as any).error).toBe("E_OUT_OF_SCOPE");
});

test("GET /vault/file — excluded path → 403 E_EXCLUDED", async () => {
  fs.mkdirSync(path.join(ctx.vaultRoot, ".obsidian"));
  fs.writeFileSync(path.join(ctx.vaultRoot, ".obsidian", "workspace.json"), "{}");
  const res = await ctx.app.request("/vault/file?path=.obsidian/workspace.json", { headers: auth });
  expect(res.status).toBe(403);
  expect((await res.json() as any).error).toBe("E_EXCLUDED");
});

test("GET /vault/file — non-UTF8 → 415 E_BINARY", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  const res = await ctx.app.request("/vault/file?path=bin", { headers: auth });
  expect(res.status).toBe(415);
  expect((await res.json() as any).error).toBe("E_BINARY");
});

test("GET /vault/file — no token → 401", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "a"), "x");
  const res = await ctx.app.request("/vault/file?path=a");
  expect(res.status).toBe(401);
});
