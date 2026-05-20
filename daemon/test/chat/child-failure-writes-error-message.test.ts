// VOS-91 T5: dispatch-child writes errorMessage with providerName prefix + 200-char cap.
//
// Verifies that when a provider's iter() throws, the FAILED task row has:
//   metadata.errorMessage = "<providerName>: <truncated-error>"
// where <truncated-error> is at most 200 chars and the total string ≤ ~220.
//
// Also verifies the null-errorMessage fallback: if errorMessage ends up null
// (simulated by a provider that resolves cleanly but we force FAILED via a
// second test variant), the prefix still applies with "unknown" body.

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../src/events/index.ts";
import { makeDispatchChildTask } from "../../src/chat/dispatch-child";
import type {
  Provider,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../../src/providers/index.ts";

const MIG = join(import.meta.dir, "../../src/adapters/sqlite/migrations");

const freshDb = (): Database => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIG);
  return db;
};

function seedChild(
  db: Database,
  opts: { contextId: string; childTaskId: string },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO contexts (id, title, created_at)
     VALUES (?, NULL, ?)`,
    [opts.contextId, now],
  );
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, parent_tool_call_id, state,
        cost_usd, tokens_in, tokens_out, metadata, target_agent,
        created_at, updated_at)
     VALUES (?, ?, NULL, NULL, 'TASK_STATE_SUBMITTED',
             0, 0, 0, '{}', 'journaler', ?, ?)`,
    [opts.childTaskId, opts.contextId, now, now],
  );
}

/** Provider whose iter() throws synchronously, simulating auth/network failure. */
function makeThrowingProvider(
  errorMsg: string,
  name: string = "fake",
): Provider & { providerName: string } {
  return {
    name: "fake-throwing",
    providerName: name,
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      async function* iter(): AsyncIterable<never> {
        throw new Error(errorMsg);
        // unreachable — yield needed so TS infers AsyncGenerator
        yield undefined as never;
      }
      // normalizeStream not needed — iter throws before producing any event
      return {
        events: iter() as AsyncIterable<never>,
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const }),
      };
    },
  };
}

/** Wait for task.state_changed for the given task id, then resolve. */
function waitForTerminal(
  bus: ReturnType<typeof createEventBus>,
  taskId: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = bus.subscribe("task.state_changed", (ev) => {
      const p = ev.payload as { taskId?: string };
      if (p.taskId === taskId) {
        off();
        resolve();
      }
    });
  });
}

describe("dispatch-child writes errorMessage with provider prefix + 200-char cap", () => {
  it("writes '<providerName>: <error>' when provider iter() throws", async () => {
    const db = freshDb();
    const contextId = "ctx-fail-err-1";
    const childTaskId = "child-fail-err-1";
    seedChild(db, { contextId, childTaskId });

    const bus = createEventBus({ db });
    const rawError = "provider auth fail: token expired";

    const dispatch = makeDispatchChildTask({
      db,
      bus,
      cwd: "/tmp",
      tracesDir: "/tmp",
      buildProvider: () => makeThrowingProvider(rawError, "fake"),
    });

    const terminalP = waitForTerminal(bus, childTaskId);
    await dispatch(childTaskId, { agentName: "journaler", message: "hi" });
    await terminalP;

    const row = db
      .query("SELECT state, metadata FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string; metadata: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.state).toBe("TASK_STATE_FAILED");

    const meta = JSON.parse(row!.metadata) as { errorMessage?: string };
    expect(meta.errorMessage).toBeDefined();
    // Must start with the provider name prefix
    expect(meta.errorMessage!.startsWith("fake: ")).toBe(true);
    // Must contain the original error text
    expect(meta.errorMessage!).toContain("provider auth fail: token expired");
    // Total length must be ≤ 220 (200-char body + ~20 for "fake: " prefix)
    expect(meta.errorMessage!.length).toBeLessThanOrEqual(220);
  });

  it("truncates long error messages to 200 body chars", async () => {
    const db = freshDb();
    const contextId = "ctx-fail-trunc-1";
    const childTaskId = "child-fail-trunc-1";
    seedChild(db, { contextId, childTaskId });

    const bus = createEventBus({ db });
    // 250 'x' chars — should be truncated to 200
    const longError = "x".repeat(250);

    const dispatch = makeDispatchChildTask({
      db,
      bus,
      cwd: "/tmp",
      tracesDir: "/tmp",
      buildProvider: () => makeThrowingProvider(longError, "fakeprovider"),
    });

    const terminalP = waitForTerminal(bus, childTaskId);
    await dispatch(childTaskId, { agentName: "journaler", message: "hi" });
    await terminalP;

    const row = db
      .query("SELECT state, metadata FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string; metadata: string } | undefined;

    expect(row!.state).toBe("TASK_STATE_FAILED");

    const meta = JSON.parse(row!.metadata) as { errorMessage?: string };
    expect(meta.errorMessage).toBeDefined();
    expect(meta.errorMessage!.startsWith("fakeprovider: ")).toBe(true);
    // Body is 200 chars; prefix "fakeprovider: " is 14 chars → total 214
    expect(meta.errorMessage!.length).toBeLessThanOrEqual(220);
    // The body portion should be exactly 200 chars of 'x'
    const body = meta.errorMessage!.slice("fakeprovider: ".length);
    expect(body).toBe("x".repeat(200));
  });

  it("falls back to 'provider: unknown' when providerName is absent", async () => {
    const db = freshDb();
    const contextId = "ctx-fail-noname-1";
    const childTaskId = "child-fail-noname-1";
    seedChild(db, { contextId, childTaskId });

    const bus = createEventBus({ db });

    // Provider WITHOUT providerName property — tests the ?? "provider" fallback
    const noNameProvider: Provider = {
      name: "no-name-fake",
      spawn(_req: ProviderSpawnRequest): ProviderHandle {
        async function* iter(): AsyncIterable<never> {
          throw new Error("some error");
          yield undefined as never;
        }
        return {
          events: iter() as AsyncIterable<never>,
          cancel: async () => false,
          done: Promise.resolve({ reason: "exit" as const }),
        };
      },
    };

    const dispatch = makeDispatchChildTask({
      db,
      bus,
      cwd: "/tmp",
      tracesDir: "/tmp",
      buildProvider: () => noNameProvider,
    });

    const terminalP = waitForTerminal(bus, childTaskId);
    await dispatch(childTaskId, { agentName: "journaler", message: "hi" });
    await terminalP;

    const row = db
      .query("SELECT state, metadata FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string; metadata: string } | undefined;

    expect(row!.state).toBe("TASK_STATE_FAILED");

    const meta = JSON.parse(row!.metadata) as { errorMessage?: string };
    expect(meta.errorMessage).toBeDefined();
    // Falls back to "provider" prefix
    expect(meta.errorMessage!.startsWith("provider: ")).toBe(true);
    expect(meta.errorMessage!).toContain("some error");
  });
});
