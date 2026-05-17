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

test("PUT /vault/file — write new file round-trips", async () => {
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "new.md", content: "hello\n" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.path).toBe(path.join(ctx.vaultRoot, "new.md"));
  expect(body.size).toBe(6);
  expect(fs.readFileSync(path.join(ctx.vaultRoot, "new.md"), "utf8")).toBe("hello\n");
});

test("PUT /vault/file — overwrites existing", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "x"), "old");
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "x", content: "new" }),
  });
  expect(res.status).toBe(200);
  expect(fs.readFileSync(path.join(ctx.vaultRoot, "x"), "utf8")).toBe("new");
});

test("PUT /vault/file — creates parent dirs", async () => {
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "a/b/c.md", content: "deep" }),
  });
  expect(res.status).toBe(200);
  expect(fs.readFileSync(path.join(ctx.vaultRoot, "a/b/c.md"), "utf8")).toBe("deep");
});

test("PUT /vault/file — body > 10MB → 413 E_TOO_LARGE", async () => {
  const big = "a".repeat(10 * 1024 * 1024 + 1);
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "big.txt", content: big }),
  });
  expect(res.status).toBe(413);
  expect((await res.json() as any).error).toBe("E_TOO_LARGE");
});

test("PUT /vault/file — excluded dest → 403 E_EXCLUDED", async () => {
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: ".obsidian/x.json", content: "{}" }),
  });
  expect(res.status).toBe(403);
  expect((await res.json() as any).error).toBe("E_EXCLUDED");
});

test("PUT /vault/file — symlink escape rejected", async () => {
  // Create a symlink inside vault that points outside vault.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.symlinkSync(outside, path.join(ctx.vaultRoot, "link"));
  try {
    const res = await ctx.app.request("/vault/file", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ path: "link/x.md", content: "escape!" }),
    });
    expect(res.status).toBe(403);
    const err = (await res.json() as any).error;
    // Either E_SYMLINK_ESCAPE or E_OUT_OF_SCOPE acceptable; both block.
    expect(["E_SYMLINK_ESCAPE", "E_OUT_OF_SCOPE"]).toContain(err);
    expect(fs.existsSync(path.join(outside, "x.md"))).toBe(false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("PUT /vault/file — malformed body → 400 E_INVALID_BODY", async () => {
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "", content: "x" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("E_INVALID_BODY");
});

test("PUT /vault/file — write is atomic (no .tmp leaks on success)", async () => {
  await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "atomic.md", content: "done" }),
  });
  const siblings = fs.readdirSync(ctx.vaultRoot);
  expect(siblings.some(n => n.startsWith("atomic.md.tmp-"))).toBe(false);
});

test("GET /vault/list — shallow root", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "a.md"), "a");
  fs.writeFileSync(path.join(ctx.vaultRoot, "b.md"), "b");
  fs.mkdirSync(path.join(ctx.vaultRoot, "sub"));
  fs.writeFileSync(path.join(ctx.vaultRoot, "sub", "c.md"), "c");
  const res = await ctx.app.request("/vault/list?depth=1", { headers: auth });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.path).toBe(ctx.vaultRoot);
  const names = (body.entries as any[]).map(e => e.name).sort();
  expect(names).toEqual(["a.md", "b.md", "sub"]);
  const sub = (body.entries as any[]).find(e => e.name === "sub");
  expect(sub.type).toBe("dir");
});

test("GET /vault/list — deep includes nested entries", async () => {
  fs.mkdirSync(path.join(ctx.vaultRoot, "x"));
  fs.writeFileSync(path.join(ctx.vaultRoot, "x", "y.md"), "y");
  const res = await ctx.app.request("/vault/list?path=x", { headers: auth });
  const body = (await res.json()) as any;
  expect(body.entries.map((e: any) => e.name)).toEqual(["y.md"]);
});

test("GET /vault/list — excludes .obsidian + dotfiles", async () => {
  fs.mkdirSync(path.join(ctx.vaultRoot, ".obsidian"));
  fs.writeFileSync(path.join(ctx.vaultRoot, ".obsidian", "x"), "");
  fs.writeFileSync(path.join(ctx.vaultRoot, ".env"), "");
  fs.writeFileSync(path.join(ctx.vaultRoot, "visible.md"), "");
  const res = await ctx.app.request("/vault/list?depth=1", { headers: auth });
  const body = (await res.json()) as any;
  const names = (body.entries as any[]).map(e => e.name);
  expect(names).toEqual(["visible.md"]);
});

test("GET /vault/list — missing path → 404", async () => {
  const res = await ctx.app.request("/vault/list?path=nope", { headers: auth });
  expect(res.status).toBe(404);
});

test("GET /vault/list — traversal → 403", async () => {
  const res = await ctx.app.request("/vault/list?path=../..", { headers: auth });
  expect(res.status).toBe(403);
});
