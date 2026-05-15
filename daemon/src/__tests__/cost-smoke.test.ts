import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../adapters/sqlite/migrations";
import { mountApi } from "../api";
import type { ApiContext } from "../api";
import { subscribeRunEnd } from "../cost";
import type { EventBus, DaemonEvent, RunEndEvent } from "../events";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "adapters", "sqlite", "migrations");

function tinyBus(): EventBus & { fire: (ev: DaemonEvent) => void } {
  const handlers: Record<string, ((ev: DaemonEvent) => void)[]> = {};
  return {
    emit: (ev) => (handlers[ev.type] ?? []).forEach((h) => h(ev)),
    subscribe: (type, h) => {
      (handlers[type] ??= []).push(h);
      return () => {};
    },
    query: async () => [],
    fire: (ev) => (handlers[ev.type] ?? []).forEach((h) => h(ev)),
  };
}

describe("VOS-81 smoke — event → row → /cost/today", () => {
  test("end-to-end: synthetic run.end event surfaces in /cost/today", async () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS_DIR);
    const bus = tinyBus();
    subscribeRunEnd(bus, db, { warn: () => {} });

    const app = new Hono();
    // Typed ApiContext so a missing `db` field on the interface fails compile.
    const ctx: ApiContext = { version: "test", db };
    mountApi(app, ctx);

    const ev: RunEndEvent = {
      type: "run.end",
      runId: "smoke-run",
      chatId: "smoke-chat",
      ts: Date.now(),
      payload: {
        agent: "primary",
        endedAt: Date.now(),
        usageTurns: [{
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          model: "claude-opus-4-7",
        }],
      },
    };
    bus.fire(ev);

    const res = await app.request("/cost/today");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.usd).toBeCloseTo(22.5, 6); // 1M * 15e-6 + 100k * 75e-6 = 15 + 7.5
    expect(body.tokens_in).toBe(1_000_000);
    expect(body.tokens_out).toBe(100_000);
  });
});
