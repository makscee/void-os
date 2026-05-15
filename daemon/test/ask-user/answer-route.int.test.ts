// VOS-88 T8: integration test for POST /chat/:chat_id/answer Hono route.
//
// Reconciliations vs plan §T8:
//   - `runMigrationsFromDir` is NOT re-exported from .../sqlite/index.ts; we
//     inline the migration runner the same way T6 does.
//   - Post-0007 there is no `chats` table — it was renamed to `contexts` and
//     has no `task_id`/`context_id` columns. The URL `:chat_id` IS the
//     context id. The answer route resolves task_id via `openTaskFor(db,
//     contextId)`. Seed mirrors handler.int.test.ts: contexts.agent_name +
//     archived NOT NULL, tasks.tokens_* NOT NULL, runs.agent/kind/started_at
//     NOT NULL.

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { createEventBus } from "../../src/events";
import { createPendingRegistry } from "../../src/adapters/mcp/pending-questions";
import { mountAnswerRoute } from "../../src/api/answer";
import { setTaskInputRequired } from "../../src/chat/ask-user-repo";

const MIGRATIONS = join(import.meta.dir, "../../src/adapters/sqlite/migrations");

function runMigrations(db: Database) {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    db.exec(sql);
  }
}

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  db.run(
    "INSERT INTO contexts (id, agent_name, title, created_at, updated_at, archived) VALUES ('ctx', 'maya', NULL, 0, 0, 0)",
  );
  db.run(
    "INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at) " +
      "VALUES ('t', 'ctx', 'TASK_STATE_WORKING', 0, 0, 0, '{}', 0, 0)",
  );
  db.run(
    "INSERT INTO runs (id, chat_id, task_id, agent, kind, status, started_at) " +
      "VALUES ('r', 'ctx', 't', 'maya', 'chat', 'running', 0)",
  );
  const bus = createEventBus();
  const pending = createPendingRegistry();
  const app = new Hono();
  mountAnswerRoute(app, { db, bus, pending });
  return { db, bus, pending, app };
}

describe("POST /chat/:chat_id/answer", () => {
  it("happy path: writes tool_result, flips state, resolves pending", async () => {
    const { db, pending, app } = fixture();
    expect(setTaskInputRequired(db, "t", "tu-1", "ok?", ["yes", "no"])).toBe(true);
    const p = pending.register("tu-1", 5_000);

    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1", answer: "yes" }),
    });
    expect(res.status).toBe(200);

    const answer = await p;
    expect(answer).toBe("yes");

    const row = db.query("SELECT state FROM tasks WHERE id='t'").get() as {
      state: string;
    };
    expect(row.state).toBe("TASK_STATE_WORKING");
    // Reconcile: plan asserted parts_text="yes", but messages-repo only
    // populates parts_text from TextParts. Tool_result is encoded as a
    // DataPart, so the answer lives in `parts` JSON (not parts_text).
    const msg = db
      .query(
        "SELECT role, parts FROM messages WHERE task_id='t' ORDER BY ord DESC LIMIT 1",
      )
      .get() as { role: string; parts: string };
    expect(msg.role).toBe("ROLE_USER");
    const parts = JSON.parse(msg.parts) as Array<{
      data?: { kind?: string; output?: string; tool_call_id?: string };
    }>;
    expect(parts[0]?.data?.kind).toBe("tool_result");
    expect(parts[0]?.data?.output).toBe("yes");
    expect(parts[0]?.data?.tool_call_id).toBe("tu-1");
  });

  it("409 on mismatched tool_use_id", async () => {
    const { db, app } = fixture();
    setTaskInputRequired(db, "t", "tu-1", "ok?", undefined);
    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-OTHER", answer: "yes" }),
    });
    expect(res.status).toBe(409);
    const row = db.query("SELECT state FROM tasks WHERE id='t'").get() as {
      state: string;
    };
    expect(row.state).toBe("TASK_STATE_INPUT_REQUIRED");
  });

  it("409 when task is WORKING (no open question)", async () => {
    const { app } = fixture();
    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1", answer: "yes" }),
    });
    expect(res.status).toBe(409);
  });

  it("404 when chat does not exist", async () => {
    const { app } = fixture();
    const res = await app.request("/chat/nope/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1", answer: "yes" }),
    });
    expect(res.status).toBe(404);
  });

  it("400 on missing fields", async () => {
    const { app } = fixture();
    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1" }),
    });
    expect(res.status).toBe(400);
  });
});
