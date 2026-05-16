// VOS-97 T4: factory-shape test for ask-agent.
//
// Asserts:
//   1. askAgentDef exports a Zod raw-shape inputSchema (not JSON Schema literal).
//   2. Runtime ids (task_id, context_id) are NOT in the input schema —
//      they live in MCP `_meta` per ADR-0002.
//   3. Handler returns ASK_AGENT_MISSING_TASK_ID when extra._meta.task_id absent.

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { makeAskAgent, askAgentDef } from "../../src/adapters/mcp/tools/ask-agent";
import { createEventBus } from "../../src/events";

describe("ask-agent factory", () => {
  it("askAgentDef exposes Zod input shape; runtime ids not in schema", () => {
    const shape = askAgentDef.inputSchema as Record<string, { _def?: unknown }>;
    expect(shape.target_agent_id?._def).toBeDefined();
    expect(shape.message?._def).toBeDefined();
    expect(shape.system_message?._def).toBeDefined();
    expect(shape.task_id).toBeUndefined();
    expect(shape.context_id).toBeUndefined();
  });

  it("returns ASK_AGENT_MISSING_TASK_ID when _meta.task_id absent", async () => {
    const db = new Database(":memory:");
    const handler = makeAskAgent({
      db,
      bus: createEventBus(),
      loadAgentDefn: () => {
        throw new Error("unreachable");
      },
      dispatchChildTask: async () => {
        /* unreachable */
      },
      now: () => Date.now(),
    });
    const out = await handler(
      { target_agent_id: "a", message: "m" },
      { _meta: {} } as any,
    );
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain(
      "ASK_AGENT_MISSING_TASK_ID",
    );
  });
});
