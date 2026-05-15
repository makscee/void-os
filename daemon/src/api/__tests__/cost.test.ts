// VOS-81 T4: GET /cost/today route tests.
//
// Coverage:
//   1. Empty DB → {usd:0, tokens_in:0, tokens_out:0} status 200
//   2. One row today → correct aggregation of tokens_in/tokens_out/usd
//   3. Shape: response keys sorted === ["tokens_in", "tokens_out", "usd"]

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../adapters/sqlite/migrations";
import type { ApiContext } from "../index";
import { mountCost } from "../cost";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "adapters", "sqlite", "migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
}

function makeApp(db: Database): Hono {
  const app = new Hono();
  const ctx: ApiContext = { version: "test", db };
  mountCost(app, ctx);
  return app;
}

describe("GET /cost/today", () => {
  test("empty db → zero rollup with status 200", async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await app.request("/cost/today");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ usd: 0, tokens_in: 0, tokens_out: 0 });
    db.close();
  });

  test("one row today → correct tokens_in / tokens_out / usd", async () => {
    const db = freshDb();
    // Insert a cost row with ts = now (epoch ms)
    const nowMs = Date.now();
    db.run(
      `INSERT INTO costs (run_id, chat_id, agent, ts, cost_usd,
                          input_tokens, output_tokens,
                          cache_create_tokens, cache_read_tokens, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["run-1", "chat-1", "maya", nowMs, 1.5,
       100, 20, 5, 3, "claude-opus-4-7"],
    );
    const app = makeApp(db);
    const res = await app.request("/cost/today");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // tokens_in = input_tokens + cache_create_tokens + cache_read_tokens = 100 + 5 + 3 = 108
    expect(body.tokens_in).toBe(108);
    // tokens_out = output_tokens = 20
    expect(body.tokens_out).toBe(20);
    // usd = cost_usd = 1.5
    expect(body.usd).toBe(1.5);
    db.close();
  });

  test("shape keys exactly [tokens_in, tokens_out, usd] sorted", async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await app.request("/cost/today");
    const body = await res.json() as Record<string, unknown>;
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(["tokens_in", "tokens_out", "usd"]);
    db.close();
  });
});
