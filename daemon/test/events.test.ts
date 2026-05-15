import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/adapters/sqlite/index.js";
import { createEventBus } from "../src/events/index.js";

// SQLite persistence was removed in VOS-83 / migration 0007. The EventBus is
// now pub/sub only; we keep these tests to guard the in-memory dispatch
// machinery that cc-spawner / orchestrator / cost subscribers depend on.

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
});
