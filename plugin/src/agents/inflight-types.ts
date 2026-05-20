// VOS-160: MIRROR of daemon AgentEvent + InflightAgent.
// Source of truth: daemon/src/agents/inflight.ts. Keep in sync —
// if you add a field here, add it there in the same PR.
//
// Local copy avoids a cross-package import; the daemon and plugin
// build independently.

export type AgentEventKind =
  | "spawn"
  | "tool_call"
  | "tool_return"
  | "sw_write"
  | "status"
  | "end"
  | "text";

/** Schema v1 — see daemon/src/agents/inflight.ts. Consumers MUST tolerate
 *  the absence of every optional field. */
export interface AgentEvent {
  ts: string;
  agent_id: string;
  parent_id: string | null;
  kind: AgentEventKind;
  summary: string;
  source?: "daemon" | "cc-hook";
  tool?: string;
  tool_call_id?: string;
  state?: string;
  reason?: string;
}

/** One in-flight (or recently-ended) agent in the inspector snapshot. */
export interface InflightAgent {
  agent_id: string;
  parent_id: string | null;
  task_id: string;
  started_at: string;
  current_phase: string;
  last_action: string;
  last_summary: string;
  last_ts: string;
  /** Bounded ordered event history — powers the click-to-expand trace. */
  trace: AgentEvent[];
  /** True once a terminal event landed; row lingers for a grace window. */
  ended: boolean;
  ended_at_ms: number | null;
}
