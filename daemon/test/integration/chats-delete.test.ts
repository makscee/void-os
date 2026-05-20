// Integration tests for DELETE /chats/:id (VOS-153 Task 2).
//
// Drives the Hono app via `app.fetch` (no port). Migration loading +
// in-memory DB pattern mirrors chats-routes.test.ts.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/adapters/sqlite/migrations.ts";
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
  applyMigrations(
    db,
    loadMigrations(MIGRATIONS_DIR).filter(
      (mg) => mg.version.slice(0, 4) <= "0016",
    ),
  );
  // Migration 0014 drops the placeholder `maya` seed; re-seed it for the
  // strict POST /chats agent validation (VOS-168).
  db.run(
    "INSERT INTO agents (name, description, model, vault_path, updated_at) VALUES ('maya','Default void-os agent.','opus','agents/maya/agent.md',0)",
  );
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
