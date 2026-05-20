import { describe, expect, test, beforeAll } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../adapters/sqlite/migrations";
import { createEventBus } from "../events";
import { subscribeRunEnd } from "../cost/index";
import { mountCost } from "../api/cost";
import type { ApiContext } from "../api/index";

const MIGRATIONS_DIR = join(__dirname, "..", "adapters", "sqlite", "migrations");

beforeAll(() => {
  process.env.VOID_TZ = "UTC";
});

describe("cost smoke — end to end", () => {
  test("synthetic run.end → /cost/today reflects payload + tasks projection", async () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS_DIR);
    const bus = createEventBus();
    const log = { warn: () => {} };
    subscribeRunEnd(bus, db, log);

    const now = Date.now();
    db.run(`INSERT INTO contexts (id, agent_name, title, created_at, updated_at, archived)
            VALUES ('ctx-smoke', 'aurora', 't', ?, ?, 0)`, [now, now]);
    db.run(`INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
            VALUES ('task-smoke', 'ctx-smoke', 'TASK_STATE_WORKING', 0, 0, 0, '{}', ?, ?)`, [now, now]);

    bus.emit({
      type: "run.end",
      runId: "run-smoke",
      chatId: "ctx-smoke",
      payload: {
        agent: "aurora",
        endedAt: now,
        taskId: "task-smoke",
        usageTurns: [
          { inputTokens: 100, outputTokens: 50,  cacheCreateTokens: 10, cacheReadTokens: 5,  model: "claude-sonnet-4-6", provider: "claude-code" },
          { inputTokens:  20, outputTokens: 10,  cacheCreateTokens:  0, cacheReadTokens: 0,  model: "claude-haiku-4-5",  provider: "claude-code" },
        ],
      },
    });

    const app = new Hono();
    const ctx: ApiContext = { version: "test", db, tz: "UTC", vaultRoot: "/tmp", token: "test-token", bootTime: 0 };
    mountCost(app, ctx);

    const res = await app.request("/cost/today");
    const body = await res.json();

    expect(body.total.input_tokens).toBe(120);
    expect(body.total.output_tokens).toBe(60);
    expect(body.total.cache_create_tokens).toBe(10);
    expect(body.total.cache_read_tokens).toBe(5);
    expect(body.by_task).toHaveLength(1);
    expect(body.by_task[0].task_id).toBe("task-smoke");
    expect(body.by_chat).toHaveLength(1);
    expect(body.by_chat[0].chat_id).toBe("ctx-smoke");

    const t = db.query("SELECT cost_usd, tokens_in, tokens_out FROM tasks WHERE id = 'task-smoke'").get() as { cost_usd: number; tokens_in: number; tokens_out: number };
    expect(t.tokens_in).toBe(120);   // SUM(input_tokens) only — no cache fold
    expect(t.tokens_out).toBe(60);
    expect(t.cost_usd).toBeCloseTo(body.total_usd, 6);
  });
});
