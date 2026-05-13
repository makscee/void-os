import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/adapters/sqlite/index.js";
import { createEventBus } from "../src/events/index.js";

const withDb = <T>(fn: (db: ReturnType<typeof openDatabase>) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "void-os-events-"));
  const dbPath = join(dir, "state.sqlite");
  const db = openDatabase(dbPath);
  const cleanup = () => {
    try { db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  };
  let result: T;
  try {
    result = fn(db);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (v) => { cleanup(); return v; },
      (e) => { cleanup(); throw e; },
    ) as unknown as T;
  }
  cleanup();
  return result;
};

describe("EventBus", () => {
  test("emit persists to events table and returns via query", async () => {
    withDb((db) => {
      const bus = createEventBus({ db });
      bus.emit({ type: "run.start", runId: "r1", chatId: "c1", payload: { agent: "maya" } });
      bus.emit({ type: "run.end", runId: "r1", payload: { exitCode: 0 } });

      return Promise.resolve().then(async () => {
        const rows = await bus.query({ runId: "r1" });
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.type).sort()).toEqual(["run.end", "run.start"]);
        const start = rows.find((r) => r.type === "run.start")!;
        expect(start.runId).toBe("r1");
        expect(start.chatId).toBe("c1");
        expect(start.payload).toEqual({ agent: "maya" });
        expect(typeof start.ts).toBe("number");
      });
    });
  });

  test("subscribe fires synchronously on emit", () => {
    withDb((db) => {
      const bus = createEventBus({ db });
      const got: string[] = [];
      const unsub = bus.subscribe("run.start", (e) => got.push(e.runId ?? ""));
      bus.emit({ type: "run.start", runId: "r1", payload: {} });
      bus.emit({ type: "run.end",   runId: "r1", payload: {} });
      bus.emit({ type: "run.start", runId: "r2", payload: {} });
      unsub();
      bus.emit({ type: "run.start", runId: "r3", payload: {} });
      expect(got).toEqual(["r1", "r2"]);
    });
  });

  test("wildcard subscribe receives all types", () => {
    withDb((db) => {
      const bus = createEventBus({ db });
      const got: string[] = [];
      bus.subscribe("*", (e) => got.push(e.type));
      bus.emit({ type: "a", payload: {} });
      bus.emit({ type: "b", payload: {} });
      expect(got).toEqual(["a", "b"]);
    });
  });

  test("handler exception does not propagate or stop other handlers", () => {
    withDb((db) => {
      const bus = createEventBus({ db });
      const got: string[] = [];
      bus.subscribe("x", () => { throw new Error("boom"); });
      bus.subscribe("x", (e) => got.push(e.type));
      expect(() => bus.emit({ type: "x", payload: {} })).not.toThrow();
      expect(got).toEqual(["x"]);
    });
  });

  test("query filters: since, type, runId", async () => {
    await withDb(async (db) => {
      const bus = createEventBus({ db });
      const t0 = Date.now();
      bus.emit({ type: "a", runId: "r1", payload: {}, ts: t0 });
      bus.emit({ type: "b", runId: "r1", payload: {}, ts: t0 + 10 });
      bus.emit({ type: "a", runId: "r2", payload: {}, ts: t0 + 20 });

      const byType  = await bus.query({ type: "a" });
      expect(byType.map((r) => r.runId).sort()).toEqual(["r1", "r2"]);

      const byRun   = await bus.query({ runId: "r1" });
      expect(byRun.map((r) => r.type).sort()).toEqual(["a", "b"]);

      const sinceMid = await bus.query({ since: t0 + 5 });
      expect(sinceMid).toHaveLength(2);
    });
  });
});
