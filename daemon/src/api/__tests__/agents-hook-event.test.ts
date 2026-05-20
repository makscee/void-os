// VOS-162: tests for the Source-A CC harness hook ingest route.
// VOS-164: + the agent_id correlation gate.
//
// Covers:
//   - a well-formed PreToolUse/PostToolUse hook event 200s and emits an
//     `agent.event` carrying `source: "cc-hook"`
//   - missing agent_id → 400 (the event can't join the union without it)
//   - an unrecognised kind → 400
//   - malformed JSON → 400
//   - the emitted event correlates on the posted agent_id
//   - VOS-164: an agent_id the daemon never spawned → 403 (forged event)
//   - VOS-164: once a run finalizes its agent_id is dropped → later events 403

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createEventBus, type DaemonEvent } from "../../events/index.ts";
import type { AgentEvent } from "../../agents/inflight.ts";
import { mountAgentsHookEvent } from "../agents-hook-event.ts";
import { createLiveAgentRegistry } from "../../agents/live-agents.ts";

// VOS-164: the harness pre-registers the agent_ids the tests post under so
// the correlation gate accepts them. `liveAgents` is exposed so tests can
// exercise the unknown-agent / drained-agent rejection paths directly.
function makeHarness(spawnedAgentIds: string[] = ["task-7", "task-8"]) {
  const bus = createEventBus();
  const app = new Hono();
  const liveAgents = createLiveAgentRegistry();
  for (const id of spawnedAgentIds) liveAgents.register(id);
  mountAgentsHookEvent(app, { bus, liveAgents });
  const events: DaemonEvent[] = [];
  bus.subscribe("agent.event", (ev) => events.push(ev));
  return { app, events, liveAgents };
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

describe("VOS-164: agent_id correlation gate", () => {
  test("a forged event for an unknown agent_id → 403, no event emitted", async () => {
    const { app, events } = makeHarness();
    const res = await post(app, {
      agent_id: "task-NEVER-SPAWNED",
      kind: "tool_call",
      tool: "Bash",
      summary: "forged",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("unknown_agent");
    expect(events).toHaveLength(0);
  });

  test("an event for a live (daemon-spawned) agent_id is accepted", async () => {
    const { app, events } = makeHarness(["task-live"]);
    const res = await post(app, { agent_id: "task-live", kind: "tool_call" });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect((events[0].payload as AgentEvent).agent_id).toBe("task-live");
  });

  test("once a run finalizes (unregister) its agent_id is rejected", async () => {
    const { app, events, liveAgents } = makeHarness(["task-ending"]);
    // While running: accepted.
    let res = await post(app, { agent_id: "task-ending", kind: "tool_call" });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    // Run finalizes — spawner drops the agent_id.
    liveAgents.unregister("task-ending");
    // A late / forged hook event for the finished run is now rejected.
    res = await post(app, { agent_id: "task-ending", kind: "tool_return" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("unknown_agent");
    expect(events).toHaveLength(1); // still just the first event
  });

  test("the correlation gate runs before kind validation", async () => {
    // An unknown agent_id with ALSO a bad kind must surface unknown_agent —
    // the un-authed route rejects the un-correlated caller first, so it
    // never reveals payload-shape feedback to a forger.
    const { app } = makeHarness();
    const res = await post(app, { agent_id: "task-NOPE", kind: "explode" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("unknown_agent");
  });
});
