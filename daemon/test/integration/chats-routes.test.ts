// Integration tests for chat-lifecycle HTTP routes (VOS-79 Task 3).
//
// Drives the Hono app via `app.fetch` (no port). Migrations are loaded from
// daemon/src/adapters/sqlite/migrations/, matching the pattern used by
// daemon/test/chat/repo.test.ts.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

function bootstrap() {
  const db = new Database(":memory:");
  for (const m of [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const app = buildApp({ db, vaultRoot });
  return { app, db, vaultRoot };
}

test("POST /chats creates chat returning id+title+created_at", async () => {
  const { app } = bootstrap();
  const res = await app.request("/chats", {
    method: "POST",
    body: JSON.stringify({ agent: "maya" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    id: string;
    title: string | null;
    created_at: number;
  };
  expect(body.id).toBeTruthy();
  expect(body.title).toBeNull();
  expect(body.created_at).toBeTruthy();
});

test("GET /chats returns list sorted recent-first", async () => {
  const { app } = bootstrap();
  const a = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  // small delay so updated_at differs deterministically
  await new Promise((r) => setTimeout(r, 5));
  const b = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  const list = (await (await app.request("/chats")).json()) as Array<{
    id: string;
    agent: string;
    title: string | null;
    last_msg: string | null;
    updated_at: number;
    last_run_status: string | null;
  }>;
  expect(Array.isArray(list)).toBe(true);
  expect(list.length).toBe(2);
  // Recent-first: b (created last) must come before a.
  expect(list[0].id).toBe(b.id);
  expect(list[1].id).toBe(a.id);
  // Shape sanity: list rows include last_msg (preview) field per repo contract.
  expect(list[0]).toHaveProperty("last_msg");
});

test("GET /chats on empty DB returns empty array", async () => {
  const { app } = bootstrap();
  const res = await app.request("/chats");
  expect(res.status).toBe(200);
  const body = (await res.json()) as unknown[];
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBe(0);
});

test("GET /chat/:id returns 404 when missing", async () => {
  const { app } = bootstrap();
  const res = await app.request("/chat/does-not-exist");
  expect(res.status).toBe(404);
});

test("GET /chat/:id returns row for existing", async () => {
  const { app } = bootstrap();
  const created = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  const res = await app.request(`/chat/${created.id}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(created.id);
});
