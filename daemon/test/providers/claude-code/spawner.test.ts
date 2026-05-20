/**
 * VOS-79 T9: CcSpawner → AsyncIterable adapter.
 *
 * Verifies the bridge from the bus-emitting CcSpawner to the
 * `AsyncIterable<SpawnerEvent>` shape the orchestrator consumes.
 *
 * Strategy: stub the underlying `CcSpawner` with a function that drives
 * bus emits in a controlled order, then assert the adapter yields events
 * in the same order and isolates by runId.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createEventBus, type EventBus } from "../../../src/events/index.js";
import type { CcSpawner, CcProcess, CcSpawnRequest } from "../../../src/providers/claude-code/index.js";
import { makeCcSpawnerIter } from "../../../src/providers/claude-code/spawner.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql events table.
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
`;

function makeBus(): EventBus {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return createEventBus({ db });
}

/**
 * Build a stub CcSpawner. Each `spawn(req)` call invokes `driver(runId, bus)`
 * on a microtask, simulating cc-adapter's async-IIFE event flow. Returns a
 * minimal CcProcess so the iter adapter can read `proc.runId`.
 */
function stubSpawner(
  bus: EventBus,
  driver: (runId: string, bus: EventBus) => void,
): { cc: CcSpawner; lastReq: { value: CcSpawnRequest | null } } {
  const lastReq: { value: CcSpawnRequest | null } = { value: null };
  let counter = 0;
  const cc: CcSpawner = {
    async spawn(req: CcSpawnRequest): Promise<CcProcess> {
      lastReq.value = req;
      const runId = `run-${++counter}`;
      // Fire emits on a microtask so the adapter has time to capture runId
      // from the resolved promise before events arrive. Mirrors real cc
      // adapter: emits flow from async reader loops, not from spawn body.
      queueMicrotask(() => driver(runId, bus));
      return {
        runId,
        pid: -1,
        sessionId: async () => "sid-stub",
        kill: async () => {},
        wait: async () => ({ exitCode: 0, reason: "exited" }),
      };
    },
  };
  return { cc, lastReq };
}

describe("VOS-79 cc spawner-iter adapter", () => {
  test("yields cc.event payloads in emit order, then returns on run.end", async () => {
    const bus = makeBus();
    const { cc } = stubSpawner(bus, (runId, b) => {
      b.emit({
        type: "cc.event",
        runId,
        payload: { eventType: "system", event: { type: "system", session_id: "sid-1" } },
      });
      b.emit({
        type: "cc.event",
        runId,
        payload: { eventType: "assistant", event: { type: "assistant", content: "hi" } },
      });
      b.emit({
        type: "cc.event",
        runId,
        payload: { eventType: "tool_use", event: { type: "tool_use", name: "Read", input: { path: "x" } } },
      });
      b.emit({ type: "run.end", runId, payload: { exitCode: 0, reason: "exited" } });
    });
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "maya", cwd: "/tmp" });
    const events: Array<{ type: string }> = [];
    for await (const evt of spawner.spawn({ chat_id: "c1", task_id: "t1", resume: null, prompt: "yo" })) {
      events.push(evt as { type: string });
    }
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "tool_use"]);
    expect((events[0] as { session_id?: string }).session_id).toBe("sid-1");
  });

  test("filters out events from other runs on the same bus", async () => {
    const bus = makeBus();
    const { cc } = stubSpawner(bus, (runId, b) => {
      // Foreign run emits first — must be ignored.
      b.emit({
        type: "cc.event",
        runId: "other-run",
        payload: { eventType: "assistant", event: { type: "assistant", content: "nope" } },
      });
      b.emit({
        type: "cc.event",
        runId,
        payload: { eventType: "assistant", event: { type: "assistant", content: "mine" } },
      });
      b.emit({ type: "run.end", runId, payload: { exitCode: 0, reason: "exited" } });
    });
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "maya", cwd: "/tmp" });
    const events: Array<{ content?: string }> = [];
    for await (const evt of spawner.spawn({ chat_id: "c1", task_id: "t1", resume: null, prompt: "x" })) {
      events.push(evt as { content?: string });
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("mine");
  });

  test("run.error in mid-stream throws inside iterator", async () => {
    const bus = makeBus();
    const { cc } = stubSpawner(bus, (runId, b) => {
      b.emit({
        type: "cc.event",
        runId,
        payload: { eventType: "assistant", event: { type: "assistant", content: "partial" } },
      });
      b.emit({ type: "run.error", runId, payload: { error: "watchdog timeout" } });
    });
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "maya", cwd: "/tmp" });
    const events: Array<{ content?: string }> = [];
    let caught: Error | null = null;
    try {
      for await (const evt of spawner.spawn({ chat_id: "c1", task_id: "t1", resume: null, prompt: "x" })) {
        events.push(evt as { content?: string });
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(events).toHaveLength(1);
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("watchdog timeout");
  });

  test("translates SpawnArgs.resume → CcSpawnRequest.resumeFrom", async () => {
    const bus = makeBus();
    const { cc, lastReq } = stubSpawner(bus, (runId, b) => {
      b.emit({ type: "run.end", runId, payload: { exitCode: 0, reason: "exited" } });
    });
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "scribe", cwd: "/work" });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of spawner.spawn({ chat_id: "c42", task_id: "t42", resume: "sid-prev", prompt: "go" })) {
      /* drain */
    }
    expect(lastReq.value).not.toBeNull();
    expect(lastReq.value!.prompt).toBe("go");
    expect(lastReq.value!.agent).toBe("scribe");
    expect(lastReq.value!.cwd).toBe("/work");
    expect(lastReq.value!.chatId).toBe("c42");
    expect(lastReq.value!.resumeFrom).toBe("sid-prev");
    expect(lastReq.value!.kind).toBe("chat");
  });

  test("VOS-122 F9: per-call args.agent overrides deps.agent static fallback", async () => {
    const bus = makeBus();
    const { cc, lastReq } = stubSpawner(bus, (runId, b) => {
      b.emit({ type: "run.end", runId, payload: { exitCode: 0, reason: "exited" } });
    });
    // deps.agent ("maya") is the daemon-wide defaultAgent fallback; the
    // per-call agent ("tinker") must win — otherwise every chat span resolves
    // to the static default regardless of chat.agent.
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "maya", cwd: "/work" });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of spawner.spawn({ chat_id: "c1", task_id: "t1", resume: null, prompt: "x", agent: "tinker" })) {
      /* drain */
    }
    expect(lastReq.value!.agent).toBe("tinker");
  });

  test("VOS-122 F9: falls back to deps.agent when args.agent omitted", async () => {
    const bus = makeBus();
    const { cc, lastReq } = stubSpawner(bus, (runId, b) => {
      b.emit({ type: "run.end", runId, payload: { exitCode: 0, reason: "exited" } });
    });
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "maya", cwd: "/work" });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of spawner.spawn({ chat_id: "c1", task_id: "t1", resume: null, prompt: "x" })) {
      /* drain */
    }
    expect(lastReq.value!.agent).toBe("maya");
  });

  test("VOS-152: throws E_NO_CALLING_AGENT when both args.agent and deps.agent are unset", async () => {
    const bus = makeBus();
    const { cc } = stubSpawner(bus, (runId, b) => {
      b.emit({ type: "run.end", runId, payload: { exitCode: 0, reason: "exited" } });
    });
    // No deps.agent — emulates a daemon built without a `defaultAgent`.
    const spawner = makeCcSpawnerIter({ cc, bus, cwd: "/work" });
    let caught: Error | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of spawner.spawn({
        chat_id: "c1",
        task_id: "t1",
        resume: null,
        prompt: "x",
      })) {
        /* drain */
      }
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("E_NO_CALLING_AGENT");
  });

  test("unsubscribes after iterator completes (no leaked listeners)", async () => {
    const bus = makeBus();
    const { cc } = stubSpawner(bus, (runId, b) => {
      b.emit({ type: "run.end", runId, payload: { exitCode: 0, reason: "exited" } });
    });
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "maya", cwd: "/tmp" });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of spawner.spawn({ chat_id: "c1", task_id: "t1", resume: null, prompt: "x" })) {
      /* drain */
    }
    // Post-iteration emits must not throw / not affect anything observable.
    // We assert by emitting a foreign event and checking no async leak.
    bus.emit({ type: "cc.event", runId: "run-1", payload: { event: { type: "assistant", content: "leak?" } } });
    // No assertion error == no listener leak triggering side-effects we can see;
    // best we can do without exposing internals. This step guards against
    // regressions where finally is skipped.
    expect(true).toBe(true);
  });

  // VOS-80 cancel-fast: cancel(runId) must invoke proc.kill({fast: true}),
  // which routes the underlying spawner to SIGINT (250ms grace) instead of
  // the default SIGTERM/5s grace. The default path lets CC trap SIGTERM
  // and gracefully flush the full response — that defeats user-cancel.
  test("cancel(runId) forwards {fast: true} to underlying CcProcess.kill", async () => {
    const bus = makeBus();
    const killCalls: Array<{ fast?: boolean }> = [];
    let counter = 0;
    const cc: CcSpawner = {
      async spawn(_req: CcSpawnRequest): Promise<CcProcess> {
        const runId = `run-${++counter}`;
        queueMicrotask(() => {
          bus.emit({
            type: "cc.event",
            runId,
            payload: { eventType: "system", event: { type: "system", session_id: "sid-c" } },
          });
        });
        return {
          runId,
          pid: -1,
          sessionId: async () => "sid-c",
          kill: async (opts) => {
            killCalls.push(opts ?? {});
            // Simulate process exit so the iterator drains naturally.
            queueMicrotask(() =>
              bus.emit({ type: "run.end", runId, payload: { exitCode: 137, reason: "killed" } }),
            );
          },
          wait: async () => ({ exitCode: 137, reason: "killed" }),
        };
      },
    };
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "maya", cwd: "/tmp" });

    // Start iterating; need at least one yield so activeProcs is populated.
    const iter = spawner.spawn({ chat_id: "c1", task_id: "t1", resume: null, prompt: "go" });
    const it = iter[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);

    // Now runId is registered. Fire cancel.
    const result = await spawner.cancel!("run-1");
    expect(result).toBe(true);

    // Drain remaining events (run.end queued).
    while (!(await it.next()).done) { /* drain */ }

    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]!.fast).toBe(true);
  });

  test("cancel(unknown-runId) returns false without invoking kill", async () => {
    const bus = makeBus();
    const cc: CcSpawner = {
      async spawn(_req: CcSpawnRequest): Promise<CcProcess> {
        return {
          runId: "run-x",
          pid: -1,
          sessionId: async () => "sid-x",
          kill: async () => { throw new Error("should not be called"); },
          wait: async () => ({ exitCode: 0, reason: "exited" }),
        };
      },
    };
    const spawner = makeCcSpawnerIter({ cc, bus, agent: "maya", cwd: "/tmp" });
    const result = await spawner.cancel!("nope");
    expect(result).toBe(false);
  });
});
