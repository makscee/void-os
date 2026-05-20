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
import { join } from "node:path";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/adapters/sqlite/migrations.ts";
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
  // VOS-168: migration 0016 makes Context thin and moves agent/session/run
  // onto the Task — its rebuild SELECTs `tasks.target_agent` (0011) and
  // `tasks.parent_tool_call_id` (0013), so the full ordered chain through
  // 0016 is now required. Apply via the migration runner so the
  // "void-os:fk-rebuild" marker is honoured.
  applyMigrations(
    db,
    loadMigrations(MIGRATIONS_DIR).filter(
      (mg) => mg.version.slice(0, 4) <= "0016",
    ),
  );
  // Migration 0014 drops the placeholder `maya` seed; the strict POST /chats
  // validation needs an agent row. Re-seed `maya` directly (the prior
  // cherry-picked migration list stopped before 0014 to keep this seed).
  db.run(
    "INSERT INTO agents (name, description, model, vault_path, updated_at) VALUES ('maya','Default void-os agent.','opus','agents/maya/agent.md',0)",
  );
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

// ─── VOS-104: cost_usd + input_required on /chats list ─────────────────

test("GET /chats includes cost_usd and input_required per row", async () => {
  const { app, db } = await bootstrap();

  // Chat A: flip its task to INPUT_REQUIRED and insert a $0.50 cost row.
  const created = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };
  const taskId = db
    .query("SELECT id FROM tasks WHERE context_id = ?")
    .get(created.id) as { id: string };
  db.run("UPDATE tasks SET state = 'TASK_STATE_INPUT_REQUIRED' WHERE id = ?", [
    taskId.id,
  ]);
  db.run(
    `INSERT INTO costs (run_id, chat_id, agent, ts, cost_usd, model)
     VALUES ('r1', ?, 'maya', ?, 0.50, 'sonnet')`,
    [created.id, Date.now()],
  );

  // Chat B: untouched — no costs, default WORKING state.
  const other = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };

  const list = (await (await app.request("/chats")).json()) as Array<{
    id: string;
    cost_usd: number;
    input_required: boolean;
  }>;
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  expect(byId[created.id]!.cost_usd).toBeCloseTo(0.5, 5);
  expect(byId[created.id]!.input_required).toBe(true);
  expect(byId[other.id]!.cost_usd).toBe(0);
  expect(byId[other.id]!.input_required).toBe(false);
  // Boolean coercion, not raw SQLite 0/1.
  expect(typeof byId[other.id]!.input_required).toBe("boolean");
  expect(typeof byId[created.id]!.input_required).toBe("boolean");
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
