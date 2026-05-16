// VOS-97 T3: ask-user factory shape — Zod input + _meta-driven ids.
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  makeAskUser,
  askUserDef,
  ASK_USER_DEADLINE_MS,
} from "../../src/adapters/mcp/tools/ask-user";
import { createPendingRegistry } from "../../src/adapters/mcp/pending-questions";
import { createEventBus } from "../../src/events";

function fakeExtra(meta: Record<string, unknown> = {}) {
  return { _meta: meta } as any;
}

describe("ask-user factory", () => {
  it("askUserDef exposes Zod input shape; no task_id/_vos_tool_use_id in schema", () => {
    const shape = askUserDef.inputSchema as Record<string, unknown>;
    expect(shape.question).toBeDefined();
    expect(shape.options).toBeDefined();
    expect(shape.task_id).toBeUndefined();
    expect(shape.context_id).toBeUndefined();
    expect(shape.run_id).toBeUndefined();
    expect(shape._vos_tool_use_id).toBeUndefined();
  });

  it("returns ASK_USER_MISSING_TASK_ID when _meta.task_id absent", async () => {
    const db = new Database(":memory:");
    const handler = makeAskUser({
      db,
      bus: createEventBus(),
      pending: createPendingRegistry(),
      now: () => Date.now(),
      deadlineMs: ASK_USER_DEADLINE_MS,
    });
    const out = await handler({ question: "?" }, fakeExtra({}));
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain(
      "ASK_USER_MISSING_TASK_ID",
    );
  });
});
