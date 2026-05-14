// Integration tests for chat-lifecycle HTTP routes (VOS-79 Tasks 3 + 8).
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
import type {
  Orchestrator,
  DispatchResult,
} from "../../src/chat/orchestrator.ts";
import { Conflict409 } from "../../src/chat/orchestrator.ts";
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

interface BootstrapOpts {
  orchestrator?: Orchestrator;
  titler?: Titler;
}

async function bootstrap(opts: BootstrapOpts = {}) {
  const db = new Database(":memory:");
  for (const m of [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
    "0004_messages.sql",
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  // Inject a no-op titler by default so buildApp doesn't try fetchAnthropicKey.
  const titler: Titler = opts.titler ?? { title: async () => {} };
  const app = await buildApp({
    db,
    vaultRoot,
    orchestrator: opts.orchestrator,
    titler,
  });
  return { app, db, vaultRoot };
}

test("POST /chats creates chat returning id+title+created_at", async () => {
  const { app } = await bootstrap();
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
  const { app } = await bootstrap();
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
  expect(list[0]!.id).toBe(b.id);
  expect(list[1]!.id).toBe(a.id);
  // Shape sanity: list rows include last_msg (preview) field per repo contract.
  expect(list[0]!).toHaveProperty("last_msg");
});

test("GET /chats on empty DB returns empty array", async () => {
  const { app } = await bootstrap();
  const res = await app.request("/chats");
  expect(res.status).toBe(200);
  const body = (await res.json()) as unknown[];
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBe(0);
});

test("GET /chat/:id returns 404 when missing", async () => {
  const { app } = await bootstrap();
  const res = await app.request("/chat/does-not-exist");
  expect(res.status).toBe(404);
});

test("GET /chat/:id returns row for existing", async () => {
  const { app } = await bootstrap();
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

// ─── T8: POST /chat/:id/message ─────────────────────────────────────────

test("POST /chat/:id/message — happy path returns {run_id, status}", async () => {
  let captured: { chatId: string; text: string } | null = null;
  const orch: Orchestrator = {
    async dispatch(chatId, text): Promise<DispatchResult> {
      captured = { chatId, text };
      return { run_id: "run-abc", status: "done" };
    },
    async cancel() {
      return { cancelled: false, run_id: null };
    },
  };
  const { app } = await bootstrap({ orchestrator: orch });
  const created = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  const res = await app.request(`/chat/${created.id}/message`, {
    method: "POST",
    body: JSON.stringify({ text: "hello" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as DispatchResult;
  expect(body.run_id).toBe("run-abc");
  expect(body.status).toBe("done");
  expect(captured!).toEqual({ chatId: created.id, text: "hello" });
});

test("POST /chat/:id/message — 404 when chat missing", async () => {
  const orch: Orchestrator = {
    async dispatch() {
      throw new Error("should not be called");
    },
    async cancel() {
      return { cancelled: false, run_id: null };
    },
  };
  const { app } = await bootstrap({ orchestrator: orch });
  const res = await app.request("/chat/does-not-exist/message", {
    method: "POST",
    body: JSON.stringify({ text: "hi" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_found");
});

test("POST /chat/:id/message — 409 when orchestrator throws Conflict409", async () => {
  const orch: Orchestrator = {
    async dispatch() {
      throw new Conflict409("run-already-running");
    },
    async cancel() {
      return { cancelled: false, run_id: null };
    },
  };
  const { app } = await bootstrap({ orchestrator: orch });
  const created = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  const res = await app.request(`/chat/${created.id}/message`, {
    method: "POST",
    body: JSON.stringify({ text: "hi" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(409);
  const body = (await res.json()) as {
    error: string;
    current_run_id: string;
  };
  expect(body.error).toBe("run_in_progress");
  expect(body.current_run_id).toBe("run-already-running");
});

test("POST /chat/:id/message — 500 on unexpected orchestrator error", async () => {
  const orch: Orchestrator = {
    async dispatch() {
      throw new Error("spawner exploded");
    },
    async cancel() {
      return { cancelled: false, run_id: null };
    },
  };
  const { app } = await bootstrap({ orchestrator: orch });
  const created = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  const res = await app.request(`/chat/${created.id}/message`, {
    method: "POST",
    body: JSON.stringify({ text: "hi" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(500);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("spawner exploded");
});

test("POST /chat/:id/message — 400 when text missing/empty", async () => {
  const orch: Orchestrator = {
    async dispatch() {
      throw new Error("should not be called");
    },
    async cancel() {
      return { cancelled: false, run_id: null };
    },
  };
  const { app } = await bootstrap({ orchestrator: orch });
  const created = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  const res = await app.request(`/chat/${created.id}/message`, {
    method: "POST",
    body: JSON.stringify({ text: "   " }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("text_required");
});
