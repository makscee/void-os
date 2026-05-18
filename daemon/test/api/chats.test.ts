// VOS-124 T3: Unit tests for strict agent validation in POST /chats.
//
// Strategy: drive `chatsApi(db)` directly via app.request — no buildApp,
// no titler, no orchestrator. Migrations 0001–0008 are loaded so the
// `agents` table exists and maya is seeded.
//
// Wiring choice: Option A (direct import) — chats.ts imports makeAgentRepo
// directly, matching the pattern used by agentsApi. No DI needed.

import { test, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { chatsApi } from "../../src/api/chats.ts";

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

// Load migrations through 0008 so both `agents` + `contexts`/`chats` tables exist.
const MIGRATIONS = [
  "0001_init.sql",
  "0002_runs_columns.sql",
  "0003_chat_lifecycle.sql",
  "0004_messages.sql",
  "0005_costs_cache.sql",
  "0006_costs_chat_id.sql",
  "0007_a2a_tables.sql",
  "0008_agents_recreate.sql",
];

function makeDb(): Database {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  return db;
}

function makeApp(db: Database): Hono {
  return chatsApi(db);
}

function post(app: Hono, body?: unknown): Promise<Response> {
  return app.request("/chats", {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ─── 400 E_INVALID_BODY cases ────────────────────────────────────────────────

describe("POST /chats — 400 E_INVALID_BODY", () => {
  test("missing body → 400", async () => {
    const db = makeDb();
    const app = makeApp(db);
    const res = await post(app);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("E_INVALID_BODY");
    expect(body.message).toContain("agent");
  });

  test("agent is a number (non-string) → 400", async () => {
    const db = makeDb();
    const app = makeApp(db);
    const res = await post(app, { agent: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("E_INVALID_BODY");
  });

  test("agent is empty string → 400", async () => {
    const db = makeDb();
    const app = makeApp(db);
    const res = await post(app, { agent: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("E_INVALID_BODY");
  });

  test("missing body even when registry contains maya → STILL 400 (no silent fallback)", async () => {
    // 0008 seeds maya, so the registry is non-empty — fallback must NOT happen.
    const db = makeDb();
    const app = makeApp(db);
    const res = await post(app);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("E_INVALID_BODY");
  });
});

// ─── 404 E_AGENT_NOT_FOUND cases ─────────────────────────────────────────────

describe("POST /chats — 404 E_AGENT_NOT_FOUND", () => {
  test("agent 'ghost' not in registry of {tinker} → 404", async () => {
    const db = makeDb();
    // Clear 0008-seeded maya and insert only tinker.
    db.run("DELETE FROM agents");
    db.run(
      `INSERT INTO agents (name, description, model, vault_path, updated_at)
       VALUES ('tinker', 'Test agent', 'sonnet', 'agents/tinker/agent.md', 0)`,
    );
    const app = makeApp(db);
    const res = await post(app, { agent: "ghost" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("E_AGENT_NOT_FOUND");
    expect(body.message).toContain("ghost");
  });
});

// ─── 200 success case ─────────────────────────────────────────────────────────

describe("POST /chats — 200 success", () => {
  test("agent 'tinker' in registry → 200 with id + created_at", async () => {
    const db = makeDb();
    // Replace seeded agents with tinker only.
    db.run("DELETE FROM agents");
    db.run(
      `INSERT INTO agents (name, description, model, vault_path, updated_at)
       VALUES ('tinker', 'Test agent', 'sonnet', 'agents/tinker/agent.md', 0)`,
    );
    const app = makeApp(db);
    const res = await post(app, { agent: "tinker" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      created_at: number;
    };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(typeof body.created_at).toBe("number");
    expect(body.created_at).toBeGreaterThan(0);
  });
});
