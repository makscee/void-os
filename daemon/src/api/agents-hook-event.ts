// VOS-162: Source A ingest — POST /agents/hook-event.
//
// Completes the union event view per the VOS-155 baked decision
// (2026-05-20T11:16:59Z): "event stream source → union view (CC harness
// hook + void-os runtime adapter)". Source B (daemon-internal runtime
// frames, shipped in VOS-155) and Source A (Claude Code harness hooks)
// publish into the SAME `agent.event` bus topic; the inflight registry +
// SSE fan both out indistinguishably except for the `source` discriminant.
//
// Why a separate ingest endpoint and not a shared impl with Source B:
// VOS-155 Attempt-1 NEEDS_DECISION recorded that A and B do not share
// impl. Source B observes the daemon's own in-process bus. Source A is
// out-of-process — CC spawns the PreToolUse / PostToolUse hook scripts as
// short-lived subprocesses; they reach the daemon over HTTP. This route is
// the seam where harness-side events re-enter the daemon's event plane.
//
// The hook scripts (daemon/src/providers/claude-code/hook-bin/*) POST a
// minimal payload here. The endpoint validates it, normalises it into an
// `AgentEvent` with `source: "cc-hook"`, and emits it on the bus. The
// inflight registry then treats it exactly like a Source-B event.
//
// Auth: mounted behind `makeRequireAuth` in app.ts. The hook scripts read
// the same daemon bearer token Source B's MCP surface uses.

import type { Hono } from "hono";
import type { EventBus } from "../events/index.ts";
import type { AgentEvent, AgentEventKind } from "../agents/inflight.ts";

export interface MountHookEventDeps {
  bus: EventBus;
}

/** The hook-event kinds Source A produces. A strict subset of AgentEventKind. */
const HOOK_KINDS: ReadonlySet<string> = new Set([
  "tool_call",
  "tool_return",
  "text",
  "status",
]);

interface HookEventBody {
  /** Agent identity — the task id CC ran under (VOS_HOOK_AGENT_ID env). */
  agent_id?: unknown;
  parent_id?: unknown;
  kind?: unknown;
  summary?: unknown;
  tool?: unknown;
  tool_call_id?: unknown;
}

export function mountAgentsHookEvent(app: Hono, deps: MountHookEventDeps): void {
  app.post("/agents/hook-event", async (c) => {
    let body: HookEventBody;
    try {
      body = (await c.req.json()) as HookEventBody;
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }

    // agent_id is mandatory — without it the event cannot join the union
    // (the registry keys every row on agent_id).
    if (typeof body.agent_id !== "string" || body.agent_id.length === 0) {
      return c.json({ error: "missing_agent_id" }, 400);
    }
    if (typeof body.kind !== "string" || !HOOK_KINDS.has(body.kind)) {
      return c.json({ error: "bad_kind" }, 400);
    }

    const event: AgentEvent = {
      ts: new Date().toISOString(),
      agent_id: body.agent_id,
      parent_id: typeof body.parent_id === "string" ? body.parent_id : null,
      kind: body.kind as AgentEventKind,
      summary:
        typeof body.summary === "string"
          ? body.summary.slice(0, 200)
          : `cc-hook ${body.kind}`,
      source: "cc-hook",
    };
    if (typeof body.tool === "string") event.tool = body.tool;
    if (typeof body.tool_call_id === "string") {
      event.tool_call_id = body.tool_call_id;
    }

    deps.bus.emit({ type: "agent.event", payload: event });
    return c.json({ ok: true });
  });
}
