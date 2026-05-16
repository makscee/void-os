// VOS-91 T4: dispatch-child emits chat.* frames stamped with task_id + child run_id.
//
// Verifies that after adding the onPart fan-out to runChildOnProvider, WS
// clients receive:
//   - chat.token    per text frame (delta)
//   - chat.tool_use per tool_use block
//   - chat.tool_result per tool_result block
// All frames carry chat_id = contextId, task_id = childTaskId,
// run_id = "child-<childTaskId>".

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
import type { LegacyProviderEvent } from "../../src/providers/types.ts";
import { normalizeStream } from "../helpers/normalize-stream.ts";

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
    `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at)
     VALUES (?, 'journaler', 0, ?, ?)`,
    [opts.contextId, now, now],
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

/**
 * Build a stub Provider that emits legacy CC-shaped events. normalizeStream
 * (same shim used by all other chat-level tests) converts them to canonical
 * ProviderEvent so dispatch-child sees the same shape as production.
 */
function makeFakeProvider(events: LegacyProviderEvent[]): Provider {
  return {
    name: "fake-emits",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      async function* iter(): AsyncIterable<LegacyProviderEvent> {
        for (const e of events) yield e;
      }
      return {
        events: normalizeStream(iter()),
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const }),
      };
    },
  };
}

describe("dispatch-child onPart emits chat.* frames with task_id + child run_id", () => {
  it("emits chat.token / chat.tool_use / chat.tool_result for child stream", async () => {
    const db = freshDb();
    const contextId = "ctx-emit-1";
    const childTaskId = "child-emit-1";
    seedChild(db, { contextId, childTaskId });

    const bus = createEventBus({ db });

    // Legacy CC-shaped events:
    //   - assistant message with text "A"
    //   - assistant message with tool_use block
    //   - user message with tool_result block
    //   - assistant message with text "B"
    const legacyEvents: LegacyProviderEvent[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "A" }],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tc-1", name: "noop", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tc-1",
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "B" }],
        },
      },
    ];

    const wsFrames: Array<Record<string, unknown>> = [];
    const spyEmit = (type: string, payload: Record<string, unknown>): void => {
      wsFrames.push({ type, ...payload });
    };

    const dispatch = makeDispatchChildTask({
      db,
      bus,
      cwd: "/tmp",
      tracesDir: "/tmp",
      buildProvider: () => makeFakeProvider(legacyEvents),
      emit: spyEmit,
    });

    // Wait for terminal state before asserting.
    const terminalP = new Promise<void>((resolve) => {
      const off = bus.subscribe("task.state_changed", (ev) => {
        const p = ev.payload as { taskId?: string; state?: string };
        if (p.taskId === childTaskId) {
          off();
          resolve();
        }
      });
    });

    await dispatch(childTaskId, { agentName: "journaler", message: "hi" });
    await terminalP;

    const tokens = wsFrames.filter((f) => f.type === "chat.token");
    const tuses = wsFrames.filter((f) => f.type === "chat.tool_use");
    const tres = wsFrames.filter((f) => f.type === "chat.tool_result");

    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(tuses.length).toBe(1);
    expect(tres.length).toBe(1);

    for (const f of [...tokens, ...tuses, ...tres]) {
      expect(f.chat_id).toBe(contextId);
      expect(f.task_id).toBe(childTaskId);
      expect(f.run_id).toBe("child-" + childTaskId);
    }

    // Spot-check frame payloads.
    expect(tokens[0].delta).toBe("A");
    expect(tuses[0].name).toBe("noop");
    expect(tuses[0].tool_call_id).toBe("tc-1");
    expect(tres[0].tool_call_id).toBe("tc-1");
  });

  it("mixed-frame ordering: chat.tool_use emitted BEFORE chat.token for same frame", async () => {
    // Ordering contract: for a provider frame whose content array contains
    // BOTH text and tool_use, the two-pass loop emits tool_use inline
    // (first pass) then emits the single chat.token at frame-end (second pass).
    // This test scripts a single assistant message with content:
    //   [{type:"text",text:"A"}, {type:"tool_use", id:"tu-x", name:"noop", input:{}}]
    // and asserts that chat.tool_use appears before chat.token in the captured
    // emit sequence (mirrors orchestrator.ts ordering contract at lines 514-552).
    const db = freshDb();
    const contextId = "ctx-mixed-1";
    const childTaskId = "child-mixed-1";
    seedChild(db, { contextId, childTaskId });

    const bus = createEventBus({ db });

    const legacyEvents: LegacyProviderEvent[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "A" },
            { type: "tool_use", id: "tu-x", name: "noop", input: {} },
          ],
        },
      },
    ];

    const wsFrames: Array<Record<string, unknown>> = [];
    const spyEmit = (type: string, payload: Record<string, unknown>): void => {
      wsFrames.push({ type, ...payload });
    };

    const dispatch = makeDispatchChildTask({
      db,
      bus,
      cwd: "/tmp",
      tracesDir: "/tmp",
      buildProvider: () => makeFakeProvider(legacyEvents),
      emit: spyEmit,
    });

    const terminalP = new Promise<void>((resolve) => {
      const off = bus.subscribe("task.state_changed", (ev) => {
        const p = ev.payload as { taskId?: string; state?: string };
        if (p.taskId === childTaskId) {
          off();
          resolve();
        }
      });
    });

    await dispatch(childTaskId, { agentName: "journaler", message: "hi" });
    await terminalP;

    const relevantFrames = wsFrames.filter(
      (f) => f.type === "chat.tool_use" || f.type === "chat.token",
    );
    // Must have at least one tool_use and one token frame.
    const toolUseIdx = relevantFrames.findIndex((f) => f.type === "chat.tool_use");
    const tokenIdx = relevantFrames.findIndex((f) => f.type === "chat.token");
    expect(toolUseIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    // Ordering contract: tool_use appears BEFORE chat.token in the same frame.
    expect(toolUseIdx).toBeLessThan(tokenIdx);
  });
});
