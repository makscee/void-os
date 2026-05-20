// Integration tests for GET /chat/:id/messages (VOS-79 Task 4).
//
// Kept separate from chats-routes.test.ts to avoid merge collisions while
// T3 and T4 land in parallel. Mirrors the bootstrap pattern from that file.
//
// Deep replay semantics (DAG walk, type filtering, malformed-line tolerance)
// are covered in daemon/test/chat/session-replay.test.ts. This file only
// verifies the route is wired: 404 for unknown chat, [] for a chat with no
// session_id yet (replay returns empty before the first turn).

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
  const app = await buildApp({ db, vaultRoot });
  return { app, db, vaultRoot };
}

test("GET /chat/:id/messages returns [] for new chat with no session_id", async () => {
  const { app } = await bootstrap();
  const created = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  const res = await app.request(`/chat/${created.id}/messages`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as unknown[];
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBe(0);
});

test("GET /chat/:id/messages 404 for missing chat", async () => {
  const { app } = await bootstrap();
  const res = await app.request("/chat/does-not-exist/messages");
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_found");
});
