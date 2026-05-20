import { describe, expect, test, beforeAll } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../adapters/sqlite/migrations";
import { mountCost } from "../cost";
import type { ApiContext } from "../index";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "adapters", "sqlite", "migrations");

// Pin TZ for deterministic day window — runs under VOID_TZ=UTC.
beforeAll(() => {
  process.env.VOID_TZ = "UTC";
});

function setup() {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  const app = new Hono();
  const ctx: ApiContext = { version: "test", db, tz: "UTC", vaultRoot: "/tmp", token: "test-token", bootTime: 0 };
  mountCost(app, ctx);
  return { app, db };
}

describe("GET /cost/today — composite shape", () => {
  test("empty DB → zeros + empty arrays", async () => {
    const { app } = setup();
    const res = await app.request("/cost/today");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      total_usd: 0,
      total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 },
      by_task: [],
      by_chat: [],
    });
  });

  test("shape — top-level keys are total_usd/total/by_task/by_chat", async () => {
    const { app } = setup();
    const res = await app.request("/cost/today");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["by_chat", "by_task", "total", "total_usd"]);
  });

  test("by_task sorted by usd DESC; by_chat sorted by usd DESC", async () => {
    const { app, db } = setup();
    const now = Date.now();
    for (const [id, usd] of [["t-low", 0.1], ["t-high", 5.0], ["t-mid", 1.0]] as Array<[string, number]>) {
      db.run(`INSERT INTO costs(run_id, task_id, chat_id, agent, provider, ts, cost_usd, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, model)
              VALUES (?, ?, ?, 'a', 'claude-code', ?, ?, 0, 0, 0, 0, 'm')`,
        [`r-${id}`, id, `c-${id}`, now, usd]);
    }
    const res = await app.request("/cost/today");
    const body = await res.json();
    expect(body.by_task.map((x: any) => x.task_id)).toEqual(["t-high", "t-mid", "t-low"]);
    expect(body.by_chat.map((x: any) => x.chat_id)).toEqual(["c-t-high", "c-t-mid", "c-t-low"]);
  });

  test("by_task excludes task_id IS NULL", async () => {
    const { app, db } = setup();
    const now = Date.now();
    db.run(`INSERT INTO costs(run_id, task_id, chat_id, agent, provider, ts, cost_usd, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, model)
            VALUES ('r1', NULL, 'chat-orphan', 'a', 'claude-code', ?, 1.0, 0, 0, 0, 0, 'm')`, [now]);
    const res = await app.request("/cost/today");
    const body = await res.json();
    expect(body.by_task).toEqual([]);
    expect(body.by_chat.map((x: any) => x.chat_id)).toEqual(["chat-orphan"]);
  });

  test("element shape — 6 keys per by_task/by_chat row", async () => {
    const { app, db } = setup();
    const now = Date.now();
    db.run(`INSERT INTO costs(run_id, task_id, chat_id, agent, provider, ts, cost_usd, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, model)
            VALUES ('r1', 't', 'c', 'a', 'claude-code', ?, 1.0, 100, 50, 10, 5, 'm')`, [now]);
    const res = await app.request("/cost/today");
    const body = await res.json();
    expect(Object.keys(body.by_task[0]).sort()).toEqual(
      ["cache_create_tokens", "cache_read_tokens", "input_tokens", "output_tokens", "task_id", "usd"],
    );
    expect(Object.keys(body.by_chat[0]).sort()).toEqual(
      ["cache_create_tokens", "cache_read_tokens", "chat_id", "input_tokens", "output_tokens", "usd"],
    );
  });
});
