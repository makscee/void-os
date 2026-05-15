import { describe, expect, test, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../adapters/sqlite/migrations";
import type { EventBus, DaemonEvent, RunEndEvent } from "../../events";
import { subscribeRunEnd, costsForToday, costsForChat } from "../index";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "adapters", "sqlite", "migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
}

// Minimal in-memory bus stub matching the EventBus interface
function makeBus(): EventBus & { fire: (ev: DaemonEvent) => void } {
  const handlers: Record<string, ((ev: DaemonEvent) => void)[]> = {};
  return {
    emit: (ev) => (handlers[ev.type] ?? []).forEach((h) => h(ev)),
    subscribe: (type, h) => {
      (handlers[type] ??= []).push(h);
      return () => { handlers[type] = (handlers[type] ?? []).filter((x) => x !== h); };
    },
    query: async () => [],
    fire: (ev) => (handlers[ev.type] ?? []).forEach((h) => h(ev)),
  };
}

const sampleEvent = (overrides: Partial<RunEndEvent> = {}): RunEndEvent => ({
  type: "run.end",
  runId: "run-1",
  chatId: "chat-1",
  ts: 1_715_731_200_000,
  payload: {
    agent: "primary",
    endedAt: 1_715_731_200_000,
    usageTurns: [{
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      model: "claude-opus-4-7",
    }],
  },
  ...overrides,
});

describe("subscribeRunEnd", () => {
  test("happy path — inserts one row with correct sums", () => {
    const db = freshDb();
    const bus = makeBus();
    const warn = mock(() => {});
    subscribeRunEnd(bus, db, { warn });
    bus.fire(sampleEvent());
    const rows = db.query("SELECT * FROM costs").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].run_id).toBe("run-1");
    expect(rows[0].chat_id).toBe("chat-1");
    expect(rows[0].model).toBe("claude-opus-4-7");
    expect(rows[0].input_tokens).toBe(1_000_000);
    expect(rows[0].output_tokens).toBe(100_000);
    expect(rows[0].cache_create_tokens).toBe(0);
    expect(rows[0].cache_read_tokens).toBe(0);
    // 1M input @ $15/M = $15, 100K output @ $75/M = $7.5
    expect(rows[0].cost_usd).toBeCloseTo(15 + 7.5, 6);
  });

  test("empty usageTurns — no INSERT, warns cost.missing_usage", () => {
    const db = freshDb();
    const bus = makeBus();
    const warn = mock(() => {});
    subscribeRunEnd(bus, db, { warn });
    bus.fire(sampleEvent({ payload: { agent: "p", endedAt: 0, usageTurns: [] } }));
    expect((db.query("SELECT COUNT(*) AS n FROM costs").get() as any).n).toBe(0);
    expect(warn).toHaveBeenCalledWith("cost.missing_usage", { runId: "run-1" });
  });

  test("mixed-model run — stores model='mixed', sums cost per-turn", () => {
    const db = freshDb();
    const bus = makeBus();
    subscribeRunEnd(bus, db, { warn: () => {} });
    bus.fire(sampleEvent({
      payload: {
        agent: "primary",
        endedAt: 0,
        usageTurns: [
          { inputTokens: 1_000_000, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-opus-4-7" },
          { inputTokens: 1_000_000, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-haiku-4-5" },
        ],
      },
    }));
    const row = db.query("SELECT model, cost_usd FROM costs").get() as any;
    expect(row.model).toBe("mixed");
    // opus: 1M input @ $15/M = $15; haiku: 1M input @ $0.8/M = $0.8
    expect(row.cost_usd).toBeCloseTo(15 + 0.8, 6);
  });

  test("unknown model in one turn — row written, cost excludes unknown, warn logged", () => {
    const db = freshDb();
    const bus = makeBus();
    const warn = mock(() => {});
    subscribeRunEnd(bus, db, { warn });
    bus.fire(sampleEvent({
      payload: {
        agent: "primary",
        endedAt: 0,
        usageTurns: [
          { inputTokens: 1_000_000, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-opus-4-7" },
          { inputTokens: 1_000_000, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, model: "claude-future-99" },
        ],
      },
    }));
    const row = db.query("SELECT cost_usd FROM costs").get() as any;
    expect(row.cost_usd).toBeCloseTo(15, 6); // future-99 contributes 0
    expect(warn).toHaveBeenCalledWith("cost.unknown_model", { model: "claude-future-99" });
  });
});

describe("costsForToday", () => {
  test("today only — excludes yesterday/tomorrow", () => {
    const db = freshDb();
    // ts values are UTC ms; SQL uses UTC day — do not switch to 'localtime'
    const nowDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const yesterday = nowDay - 86_400_000;
    const tomorrow  = nowDay + 86_400_000;
    const today     = nowDay + 12 * 3_600_000;
    const insert = (ts: number, usd: number, inTok: number, outTok: number) =>
      db.run(
        `INSERT INTO costs(run_id,agent,ts,cost_usd,input_tokens,output_tokens,cache_create_tokens,cache_read_tokens,model)
         VALUES (?,?,?,?,?,?,0,0,'claude-opus-4-7')`,
        [`r-${ts}`, "p", ts, usd, inTok, outTok],
      );
    insert(yesterday, 1.0, 100, 10);
    insert(today,     2.5, 200, 20);
    insert(tomorrow,  4.0, 400, 40);
    const result = costsForToday(db);
    expect(result.usd).toBeCloseTo(2.5, 6);
    expect(result.tokens_in).toBe(200);
    expect(result.tokens_out).toBe(20);
  });

  test("no rows — returns zeros (not nulls)", () => {
    const db = freshDb();
    expect(costsForToday(db)).toEqual({ usd: 0, tokens_in: 0, tokens_out: 0 });
  });
});

describe("costsForChat", () => {
  test("filters by chat_id", () => {
    const db = freshDb();
    const ts = Date.now();
    const insert = (chat: string, usd: number, inTok: number) =>
      db.run(
        `INSERT INTO costs(run_id,chat_id,agent,ts,cost_usd,input_tokens,output_tokens,cache_create_tokens,cache_read_tokens,model)
         VALUES (?,?,?,?,?,?,0,0,0,'claude-opus-4-7')`,
        [`r-${chat}`, chat, "p", ts, usd, inTok],
      );
    insert("chat-A", 1.0, 100);
    insert("chat-A", 2.0, 200);
    insert("chat-B", 4.0, 400);
    const a = costsForChat(db, "chat-A");
    expect(a.usd).toBeCloseTo(3.0, 6);
    expect(a.tokens_in).toBe(300);
  });
});
