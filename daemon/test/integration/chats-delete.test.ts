// Integration tests for DELETE /chats/:id (VOS-153 Task 2).
//
// Drives the Hono app via `app.fetch` (no port). Migration loading +
// in-memory DB pattern mirrors chats-routes.test.ts.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import type { Titler } from "../../src/chat/titler.ts";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

async function bootstrap() {
  const db = new Database(":memory:");
  for (const m of [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
    "0004_messages.sql",
    "0005_costs_cache.sql",
    "0006_costs_chat_id.sql",
    "0007_a2a_tables.sql",
    "0008_agents_recreate.sql",
    "0015_agents_rich_fields.sql", // VOS-153 Task 3: adds color/avatar/tagline columns (selected by repo.list)
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const titler: Titler = { title: async () => {} };
  const app = await buildApp({ db, vaultRoot, titler });
  return { app, db, vaultRoot };
}

test("DELETE /chats/:id removes an existing chat and returns 200", async () => {
  const { app } = await bootstrap();
  const create = await app.request("/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "maya" }),
  });
  expect(create.status).toBe(200);
  const { id } = (await create.json()) as { id: string };

  const del = await app.request(`/chats/${id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  const body = (await del.json()) as { id: string };
  expect(body.id).toBe(id);

  // After delete, GET /chat/:id should return 404 (per-id getter lives at
  // /chat/:id singular — see chat.ts).
  const get = await app.request(`/chat/${id}`);
  expect(get.status).toBe(404);
});

test("DELETE /chats/:id returns 404 for unknown chat id", async () => {
  const { app } = await bootstrap();
  const del = await app.request("/chats/does-not-exist", { method: "DELETE" });
  expect(del.status).toBe(404);
  const body = (await del.json()) as { error: { code: string } };
  expect(body.error.code).toBe("E_NOT_FOUND");
});
