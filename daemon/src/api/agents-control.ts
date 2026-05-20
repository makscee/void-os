// VOS-161: agent control verb routes — POST /agents/:id/{pause,resume,kill}.
//
// The two-verb intervention model on top of the VOS-155/160 inspector:
//   - POST /agents/:id/pause   → soft pause (wait-for-checkpoint)
//   - POST /agents/:id/resume  → clear a pause
//   - POST /agents/:id/kill    → hard kill (interrupt + abort)
//
// Each route resolves the agent's control handle from the
// `AgentControlRegistry`. A handle exists only while the agent is running;
// once the run reaches a terminal state dispatch-child deregisters it. So an
// unknown id (never spawned, or already terminal) returns 404 — the same
// shape POST /chat/:id/cancel uses for a missing chat.
//
// Each verb also emits an `agent.event` (kind=status) so the inspector trace
// records the intervention alongside the run's own frames.
//
// Auth: mounted behind `makeRequireAuth` in app.ts, mirroring /agents/inflight.

import type { Hono } from "hono";
import type { EventBus } from "../events/index.ts";
import type { AgentControlRegistry } from "../agents/control.ts";

export interface MountAgentsControlDeps {
  bus: EventBus;
  control: AgentControlRegistry;
}

type Verb = "pause" | "resume" | "kill";

const VERB_SUMMARY: Record<Verb, string> = {
  pause: "operator paused agent (soft pause — wait-for-checkpoint)",
  resume: "operator resumed agent",
  kill: "operator killed agent (hard kill — interrupt + abort)",
};

export function mountAgentsControl(app: Hono, deps: MountAgentsControlDeps): void {
  const handle = (verb: Verb) => (c: import("hono").Context) => {
    const agentId = c.req.param("id");
    const ctrl = deps.control.get(agentId);
    if (!ctrl) {
      // Unknown id, or the run already reached a terminal state and
      // dispatch-child deregistered the handle.
      return c.json({ error: "not_found" }, 404);
    }

    if (verb === "pause") ctrl.requestPause();
    else if (verb === "resume") ctrl.requestResume();
    else ctrl.requestKill();

    // Record the intervention on the event substrate so it shows in the
    // inspector trace. Best-effort: a missing parent_id is fine.
    deps.bus.emit({
      type: "agent.event",
      payload: {
        ts: new Date().toISOString(),
        agent_id: agentId,
        parent_id: null,
        kind: "status",
        summary: VERB_SUMMARY[verb],
        state: ctrl.state(),
      },
    });

    return c.json({ agent_id: agentId, control_state: ctrl.state() });
  };

  app.post("/agents/:id/pause", handle("pause"));
  app.post("/agents/:id/resume", handle("resume"));
  app.post("/agents/:id/kill", handle("kill"));
}
