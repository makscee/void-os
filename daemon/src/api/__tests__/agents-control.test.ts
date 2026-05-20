// VOS-161: tests for the pause/kill/resume verb routes.
//
// Covers:
//   - each verb 200s against a registered agent and echoes control_state
//   - pause→resume round-trip via the HTTP surface
//   - kill flips state to "killed" and the route reports it
//   - an unknown agent_id 404s
//   - a deregistered (terminal) agent_id 404s
//   - each verb emits an agent.event (kind=status) on the bus

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createEventBus, type DaemonEvent } from "../../events/index.ts";
import { createAgentControlRegistry } from "../../agents/control.ts";
import { mountAgentsControl } from "../agents-control.ts";

function makeHarness() {
  const bus = createEventBus();
  const control = createAgentControlRegistry();
  const app = new Hono();
  mountAgentsControl(app, { bus, control });
  const events: DaemonEvent[] = [];
  bus.subscribe("agent.event", (ev) => events.push(ev));
  return { app, control, events };
}

async function post(app: Hono, agentId: string, verb: string) {
  return app.fetch(
    new Request(`http://x/agents/${agentId}/${verb}`, { method: "POST" }),
  );
}

describe("VOS-161: agent control verb routes", () => {
  test("pause then resume round-trips control_state", async () => {
    const { app, control } = makeHarness();
    control.register("agent-1", () => {});

    const pauseRes = await post(app, "agent-1", "pause");
    expect(pauseRes.status).toBe(200);
    expect(await pauseRes.json()).toEqual({
      agent_id: "agent-1",
      control_state: "paused",
    });
    expect(control.stateOf("agent-1")).toBe("paused");

    const resumeRes = await post(app, "agent-1", "resume");
    expect(resumeRes.status).toBe(200);
    expect(await resumeRes.json()).toEqual({
      agent_id: "agent-1",
      control_state: "running",
    });
    expect(control.stateOf("agent-1")).toBe("running");
  });

  test("kill flips state to killed and fires the abort hook", async () => {
    const { app, control } = makeHarness();
    let killed = false;
    control.register("agent-1", () => {
      killed = true;
    });

    const res = await post(app, "agent-1", "kill");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agent_id: "agent-1",
      control_state: "killed",
    });
    expect(killed).toBe(true);
    expect(control.stateOf("agent-1")).toBe("killed");
  });

  test("unknown agent_id 404s", async () => {
    const { app } = makeHarness();
    for (const verb of ["pause", "resume", "kill"]) {
      const res = await post(app, "nope", verb);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  test("a deregistered (terminal) agent 404s", async () => {
    const { app, control } = makeHarness();
    control.register("agent-1", () => {});
    control.deregister("agent-1");

    const res = await post(app, "agent-1", "kill");
    expect(res.status).toBe(404);
  });

  test("each verb emits an agent.event status frame", async () => {
    const { app, control, events } = makeHarness();
    control.register("agent-1", () => {});

    await post(app, "agent-1", "pause");
    await post(app, "agent-1", "resume");
    await post(app, "agent-1", "kill");

    expect(events).toHaveLength(3);
    for (const ev of events) {
      const p = ev.payload as { agent_id: string; kind: string; state: string };
      expect(p.agent_id).toBe("agent-1");
      expect(p.kind).toBe("status");
      expect(["running", "paused", "killed"]).toContain(p.state);
    }
    // The kill frame must report the killed state.
    const last = events[2].payload as { state: string };
    expect(last.state).toBe("killed");
  });
});
