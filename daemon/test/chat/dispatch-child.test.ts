// VOS-89 review-fix unit tests for makeDispatchChildTask.
//
// Covers two findings from the T17 review pass:
//   - Finding 1: deps.cwd is threaded through to provider.spawn (NOT
//     hardcoded to "/tmp" any more).
//   - Finding 2: when the provider stream throws, the error string is
//     persisted to tasks.metadata.errorMessage so translateChildResult
//     can surface it via `child task failed: <real error>` instead of
//     the generic "unknown" placeholder.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../src/events/index.ts";
import { makeDispatchChildTask } from "../../src/chat/dispatch-child";
import type {
  Provider,
  ProviderEvent,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../../src/providers/index.ts";

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "../../src/adapters/sqlite/migrations",
);

const freshDb = (): Database => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
};

function seed(db: Database): { contextId: string; childTaskId: string } {
  const now = Math.floor(Date.now() / 1000);
  const contextId = "ctx-d";
  const childTaskId = "child-d";
  db.run(
    `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at)
     VALUES (?, 'journaler', 0, ?, ?)`,
    [contextId, now, now],
  );
  // Child mint inserts in SUBMITTED — mirror that here so dispatch-child's
  // SUBMITTED -> WORKING flip is observable.
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, state,
        cost_usd, tokens_in, tokens_out, metadata,
        created_at, updated_at, target_agent)
     VALUES (?, ?, NULL, 'TASK_STATE_SUBMITTED',
             0, 0, 0, '{}', ?, ?, 'journaler')`,
    [childTaskId, contextId, now, now],
  );
  return { contextId, childTaskId };
}

/**
 * Build a stub Provider that captures the spawn request. Kind of test
 * that proves cwd threading by inspecting what spawn actually saw.
 */
function captureProvider(opts: {
  events?: ProviderEvent[];
  throwOnIter?: string;
}): { provider: Provider; lastReq: { value: ProviderSpawnRequest | null } } {
  const lastReq = { value: null as ProviderSpawnRequest | null };
  const provider: Provider = {
    name: "stub",
    spawn(req: ProviderSpawnRequest): ProviderHandle {
      lastReq.value = req;
      const events = opts.events ?? [];
      async function* iter(): AsyncIterable<ProviderEvent> {
        for (const e of events) yield e;
        if (opts.throwOnIter) throw new Error(opts.throwOnIter);
      }
      return {
        events: iter(),
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const }),
      };
    },
  };
  return { provider, lastReq };
}

describe("makeDispatchChildTask", () => {
  test("Finding 1: threads deps.cwd to provider.spawn (not '/tmp')", async () => {
    const db = freshDb();
    const bus = createEventBus({ db });
    const { contextId, childTaskId } = seed(db);
    const { provider, lastReq } = captureProvider({
      events: [
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        },
      ],
    });

    const VAULT_CWD = "/tmp/vault-fixture-xyzzy";
    const dispatch = makeDispatchChildTask({
      db,
      bus,
      cwd: VAULT_CWD,
      tracesDir: "/tmp/traces-irrelevant",
      buildProvider: () => provider,
    });

    // Wait for the child to terminate via state_changed.
    const terminalP = new Promise<string>((resolve) => {
      const off = bus.subscribe("task.state_changed", (ev) => {
        const p = ev.payload as { taskId?: string; state?: string };
        if (p.taskId === childTaskId && p.state) {
          off();
          resolve(p.state);
        }
      });
    });

    await dispatch(childTaskId, { agentName: "journaler", message: "hi" });
    const terminal = await terminalP;

    expect(terminal).toBe("TASK_STATE_COMPLETED");
    expect(lastReq.value).not.toBeNull();
    expect(lastReq.value!.cwd).toBe(VAULT_CWD);
    expect(lastReq.value!.cwd).not.toBe("/tmp");
    // contextId is still threaded as chatId.
    expect(lastReq.value!.chatId).toBe(contextId);
  });

  test("Finding 2: provider error persists to tasks.metadata.errorMessage", async () => {
    const db = freshDb();
    const bus = createEventBus({ db });
    const { childTaskId } = seed(db);
    const { provider } = captureProvider({
      throwOnIter: "provider exploded: boom-42",
    });

    const dispatch = makeDispatchChildTask({
      db,
      bus,
      cwd: "/tmp/vault-fixture",
      tracesDir: "/tmp/traces",
      buildProvider: () => provider,
    });

    const terminalP = new Promise<string>((resolve) => {
      const off = bus.subscribe("task.state_changed", (ev) => {
        const p = ev.payload as { taskId?: string; state?: string };
        if (p.taskId === childTaskId && p.state) {
          off();
          resolve(p.state);
        }
      });
    });

    await dispatch(childTaskId, { agentName: "journaler", message: "hi" });
    const terminal = await terminalP;

    expect(terminal).toBe("TASK_STATE_FAILED");
    const row = db
      .query("SELECT state, metadata FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string; metadata: string };
    expect(row.state).toBe("TASK_STATE_FAILED");
    const meta = JSON.parse(row.metadata) as { errorMessage?: string };
    expect(meta.errorMessage).toBe("provider exploded: boom-42");
  });
});
