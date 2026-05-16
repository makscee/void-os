import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../adapters/sqlite/migrations";
import { createEventBus } from "../../events";
import { subscribeRunEnd, costsForToday, costsForChat } from "../index";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "adapters", "sqlite", "migrations");

function setup() {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  const bus = createEventBus();
  const logs: Array<{ event: string; fields?: unknown }> = [];
  const log = { warn: (event: string, fields?: unknown) => logs.push({ event, fields }) };
  const unsub = subscribeRunEnd(bus, db, log);
  return { db, bus, log, logs, unsub };
}

function seedContextAndTask(db: Database, taskId: string, contextId: string) {
  const now = Date.now();
  db.run(
    `INSERT INTO contexts (id, agent_name, title, created_at, updated_at, archived)
     VALUES (?, 'aurora', 't', ?, ?, 0)`,
    [contextId, now, now],
  );
  db.run(
    `INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
     VALUES (?, ?, 'TASK_STATE_WORKING', 0, 0, 0, '{}', ?, ?)`,
    [taskId, contextId, now, now],
  );
}

describe("subscribeRunEnd — per-turn writes", () => {
  test("2-turn event → 2 rows in costs", () => {
    const { db, bus } = setup();
    seedContextAndTask(db, "task-1", "ctx-1");
    bus.emit({
      type: "run.end",
      runId: "run-1",
      chatId: "ctx-1",
      payload: {
        agent: "aurora",
        endedAt: Date.now(),
        taskId: "task-1",
        usageTurns: [
          { inputTokens: 100, outputTokens: 20, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-sonnet-4-6", provider: "claude-code" },
          { inputTokens: 50,  outputTokens: 10, cacheCreateTokens: 5, cacheReadTokens: 3, model: "claude-haiku-4-5",  provider: "claude-code" },
        ],
      },
    });
    const rows = db.query("SELECT model, provider, input_tokens FROM costs ORDER BY id").all() as Array<{ model: string; provider: string; input_tokens: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.model).toBe("claude-sonnet-4-6");
    expect(rows[0]!.provider).toBe("claude-code");
    expect(rows[1]!.model).toBe("claude-haiku-4-5");
    expect(rows[1]!.input_tokens).toBe(50);
  });

  test("mixed-provider run — distinct provider column per row", () => {
    const { db, bus } = setup();
    seedContextAndTask(db, "task-2", "ctx-2");
    bus.emit({
      type: "run.end",
      runId: "run-2",
      chatId: "ctx-2",
      payload: {
        agent: "aurora",
        endedAt: Date.now(),
        taskId: "task-2",
        usageTurns: [
          { inputTokens: 1, outputTokens: 1, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-sonnet-4-6", provider: "claude-code" },
          { inputTokens: 1, outputTokens: 1, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-sonnet-4-6", provider: "fake" },
        ],
      },
    });
    const providers = db.query("SELECT provider FROM costs ORDER BY id").all().map((r: any) => r.provider);
    expect(providers).toEqual(["claude-code", "fake"]);
  });

  test("tasks projection delta — exact sum across turns", () => {
    const { db, bus } = setup();
    seedContextAndTask(db, "task-3", "ctx-3");
    bus.emit({
      type: "run.end",
      runId: "run-3",
      chatId: "ctx-3",
      payload: {
        agent: "aurora",
        endedAt: 1234567890,
        taskId: "task-3",
        usageTurns: [
          { inputTokens: 100, outputTokens: 200, cacheCreateTokens: 10, cacheReadTokens: 20, model: "claude-sonnet-4-6", provider: "claude-code" },
          { inputTokens:  50, outputTokens: 100, cacheCreateTokens:  5, cacheReadTokens: 10, model: "claude-sonnet-4-6", provider: "claude-code" },
        ],
      },
    });
    const t = db.query("SELECT cost_usd, tokens_in, tokens_out, updated_at FROM tasks WHERE id = 'task-3'").get() as { cost_usd: number; tokens_in: number; tokens_out: number; updated_at: number };
    // tokens_in = pure SUM(input_tokens), no cache fold (spec §11 + §5.2 trailing note)
    expect(t.tokens_in).toBe(150);
    expect(t.tokens_out).toBe(300);
    expect(t.cost_usd).toBeGreaterThan(0);
    expect(t.updated_at).toBe(1234567890);
  });

  test("taskId null → INSERTs land, tasks untouched", () => {
    const { db, bus } = setup();
    seedContextAndTask(db, "task-4", "ctx-4");
    bus.emit({
      type: "run.end",
      runId: "run-4",
      chatId: "ctx-4",
      payload: {
        agent: "aurora",
        endedAt: Date.now(),
        taskId: null,
        usageTurns: [
          { inputTokens: 1, outputTokens: 1, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-sonnet-4-6", provider: "claude-code" },
        ],
      },
    });
    const rows = db.query("SELECT COUNT(*) as n FROM costs").get() as { n: number };
    expect(rows.n).toBe(1);
    const t = db.query("SELECT cost_usd FROM tasks WHERE id = 'task-4'").get() as { cost_usd: number };
    expect(t.cost_usd).toBe(0);
  });

  test("deleted-task UPDATE no-op → cost.task_missing warn", () => {
    const { db, bus, logs } = setup();
    seedContextAndTask(db, "task-5", "ctx-5");
    db.run("DELETE FROM tasks WHERE id = 'task-5'");
    bus.emit({
      type: "run.end",
      runId: "run-5",
      chatId: "ctx-5",
      payload: {
        agent: "aurora",
        endedAt: Date.now(),
        taskId: "task-5",
        usageTurns: [
          { inputTokens: 1, outputTokens: 1, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-sonnet-4-6", provider: "claude-code" },
        ],
      },
    });
    // costs row writes succeed (FK ON DELETE SET NULL — but the row was already gone before INSERT, so task_id is just an orphan TEXT here; the warn fires regardless)
    expect(db.query("SELECT COUNT(*) as n FROM costs").get()).toEqual({ n: 1 });
    expect(logs.some((l) => l.event === "cost.task_missing")).toBe(true);
  });

  test("missing provider on UsageTurn → defaults to 'claude-code' + warn", () => {
    const { db, bus, logs } = setup();
    seedContextAndTask(db, "task-6", "ctx-6");
    bus.emit({
      type: "run.end",
      runId: "run-6",
      chatId: "ctx-6",
      payload: {
        agent: "aurora",
        endedAt: Date.now(),
        taskId: "task-6",
        usageTurns: [
          // intentionally omit provider — runtime defensive path
          { inputTokens: 1, outputTokens: 1, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-sonnet-4-6" } as never,
        ],
      },
    });
    const row = db.query("SELECT provider FROM costs WHERE run_id = 'run-6'").get() as { provider: string };
    expect(row.provider).toBe("claude-code");
    expect(logs.some((l) => l.event === "cost.missing_provider")).toBe(true);
  });

  test("missing usageTurns → no writes + cost.missing_usage warn", () => {
    const { db, bus, logs } = setup();
    bus.emit({
      type: "run.end",
      runId: "run-7",
      chatId: "ctx-x",
      payload: {
        agent: "aurora",
        endedAt: Date.now(),
        taskId: null,
        usageTurns: [],
      },
    });
    expect(db.query("SELECT COUNT(*) as n FROM costs").get()).toEqual({ n: 0 });
    expect(logs.some((l) => l.event === "cost.missing_usage")).toBe(true);
  });

  test("tx rolls back on UPDATE failure — zero costs rows", () => {
    const { db, bus } = setup();
    seedContextAndTask(db, "task-8", "ctx-8");
    // Wrap db.prepare so the UPDATE tasks statement throws on .run().
    // Install AFTER migrations have run (setup() already ran them) and
    // BEFORE the first bus.emit, so live INSERT prepares pass through.
    // Match the EXACT SQL the cost subscriber uses for the projection
    // UPDATE; a loose `includes("UPDATE tasks")` would also stub the
    // task-state flips elsewhere (orchestrator) — false-positive throws.
    const originalPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes("UPDATE tasks") && sql.includes("cost_usd") && sql.includes("tokens_in")) {
        return new Proxy(stmt, {
          get(target, prop) {
            if (prop === "run") return () => { throw new Error("synthetic UPDATE failure"); };
            return (target as any)[prop];
          },
        });
      }
      return stmt;
    };
    bus.emit({
      type: "run.end",
      runId: "run-8",
      chatId: "ctx-8",
      payload: {
        agent: "aurora",
        endedAt: Date.now(),
        taskId: "task-8",
        usageTurns: [
          { inputTokens: 1, outputTokens: 1, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-sonnet-4-6", provider: "claude-code" },
        ],
      },
    });
    expect(db.query("SELECT COUNT(*) as n FROM costs").get()).toEqual({ n: 0 });
  });
});

describe("costsForToday — composite rollup", () => {
  test("empty DB returns zeros + empty arrays", () => {
    const { db } = setup();
    const range = { startMs: 0, endMs: 1e15 };
    expect(costsForToday(db, range)).toEqual({
      total_usd: 0,
      total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 },
      by_task: [],
      by_chat: [],
    });
  });

  test("by_task excludes task_id IS NULL; by_chat includes all", () => {
    const { db } = setup();
    const now = Date.now();
    db.run(`INSERT INTO costs(run_id, task_id, chat_id, agent, provider, ts, cost_usd, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, model)
            VALUES ('r1', 'task-A', 'chat-A', 'a', 'claude-code', ?, 1.0, 100, 50, 0, 0, 'claude-sonnet-4-6')`, [now]);
    db.run(`INSERT INTO costs(run_id, task_id, chat_id, agent, provider, ts, cost_usd, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, model)
            VALUES ('r2', NULL,     'chat-B', 'a', 'claude-code', ?, 0.5,  50, 25, 0, 0, 'claude-sonnet-4-6')`, [now]);
    const range = { startMs: now - 1000, endMs: now + 1000 };
    const res = costsForToday(db, range);
    expect(res.total_usd).toBeCloseTo(1.5, 6);
    expect(res.by_task.map((x) => x.task_id)).toEqual(["task-A"]);
    expect(res.by_chat.map((x) => x.chat_id).sort()).toEqual(["chat-A", "chat-B"]);
  });

  test("by_task sorted by usd DESC", () => {
    const { db } = setup();
    const now = Date.now();
    const rows: Array<[string, number]> = [["task-low", 0.1], ["task-high", 5.0], ["task-mid", 1.0]];
    for (const [id, usd] of rows) {
      db.run(`INSERT INTO costs(run_id, task_id, chat_id, agent, provider, ts, cost_usd, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, model)
              VALUES (?, ?, 'c', 'a', 'claude-code', ?, ?, 0, 0, 0, 0, 'claude-sonnet-4-6')`, [id, id, now, usd]);
    }
    const res = costsForToday(db, { startMs: now - 1000, endMs: now + 1000 });
    expect(res.by_task.map((x) => x.task_id)).toEqual(["task-high", "task-mid", "task-low"]);
  });
});

describe("costsForChat", () => {
  test("returns 4 token fields + usd for a chat", () => {
    const { db } = setup();
    db.run(`INSERT INTO costs(run_id, task_id, chat_id, agent, provider, ts, cost_usd, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, model)
            VALUES ('r1', NULL, 'chat-X', 'a', 'claude-code', ?, 2.0, 100, 50, 10, 5, 'claude-sonnet-4-6')`, [Date.now()]);
    const res = costsForChat(db, "chat-X");
    expect(res.usd).toBeCloseTo(2.0, 6);
    expect(res.input_tokens).toBe(100);
    expect(res.output_tokens).toBe(50);
    expect(res.cache_create_tokens).toBe(10);
    expect(res.cache_read_tokens).toBe(5);
  });
});
