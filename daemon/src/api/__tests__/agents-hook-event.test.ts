// VOS-162: tests for the Source-A CC harness hook ingest route.
//
// Covers:
//   - a well-formed PreToolUse/PostToolUse hook event 200s and emits an
//     `agent.event` carrying `source: "cc-hook"`
//   - missing agent_id → 400 (the event can't join the union without it)
//   - an unrecognised kind → 400
//   - malformed JSON → 400
//   - the emitted event correlates on the posted agent_id

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createEventBus, type DaemonEvent } from "../../events/index.ts";
import type { AgentEvent } from "../../agents/inflight.ts";
import { mountAgentsHookEvent } from "../agents-hook-event.ts";

function makeHarness() {
  const bus = createEventBus();
  const app = new Hono();
  mountAgentsHookEvent(app, { bus });
  const events: DaemonEvent[] = [];
  bus.subscribe("agent.event", (ev) => events.push(ev));
  return { app, events };
}

async function post(app: Hono, body: unknown | string) {
  return app.fetch(
    new Request("http://x/agents/hook-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("VOS-162: Source-A hook-event ingest", () => {
  test("a tool_call hook event 200s and emits a cc-hook agent.event", async () => {
    const { app, events } = makeHarness();
    const res = await post(app, {
      agent_id: "task-7",
      kind: "tool_call",
      tool: "Bash",
      summary: "PreToolUse Bash",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(events).toHaveLength(1);
    const p = events[0]!.payload as AgentEvent;
    expect(p.agent_id).toBe("task-7");
    expect(p.kind).toBe("tool_call");
    expect(p.tool).toBe("Bash");
    expect(p.source).toBe("cc-hook");
  });

  test("a tool_return hook event 200s", async () => {
    const { app, events } = makeHarness();
    const res = await post(app, {
      agent_id: "task-7",
      kind: "tool_return",
      tool: "Edit",
      summary: "PostToolUse Edit → ok",
    });
    expect(res.status).toBe(200);
    expect((events[0]!.payload as AgentEvent).kind).toBe("tool_return");
  });

  test("missing agent_id → 400 (cannot join the union)", async () => {
    const { app, events } = makeHarness();
    const res = await post(app, { kind: "tool_call", tool: "Bash" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_agent_id");
    expect(events).toHaveLength(0);
  });

  test("an unrecognised kind → 400", async () => {
    const { app } = makeHarness();
    const res = await post(app, { agent_id: "task-7", kind: "explode" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_kind");
  });

  test("malformed JSON → 400", async () => {
    const { app } = makeHarness();
    const res = await post(app, "{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_json");
  });

  test("summary is defaulted + capped at 200 chars", async () => {
    const { app, events } = makeHarness();
    await post(app, { agent_id: "task-7", kind: "tool_call" });
    expect((events[0]!.payload as AgentEvent).summary).toBe("cc-hook tool_call");

    const long = "x".repeat(500);
    await post(app, { agent_id: "task-8", kind: "tool_call", summary: long });
    expect((events[1]!.payload as AgentEvent).summary.length).toBe(200);
  });
});
