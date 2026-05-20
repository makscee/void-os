// VOS-155: in-flight agent event substrate (Phase 1, Source B only).
//
// Three concerns live here:
//
//   1. `AgentEvent` schema v1 — the wire format every inspector consumer
//      (Phase 2 plugin view, Phase 3 verbs, Phase 4 union with CC harness
//      hooks) will subscribe to.
//
//   2. `InflightRegistry` — in-memory `Map<agent_id, InflightAgent>` snapshot
//      used by `GET /agents/inflight` to answer "what's running right now".
//      Built from the same event stream the SSE delta channel publishes, so
//      snapshot + stream are derived from one source of truth.
//
//   3. Bridge — subscribes to existing daemon bus topics (chat.tool_use,
//      chat.tool_result, chat.token, task.state_changed, run.end,
//      child.dispatch_error) and translates each into an `agent.event` on
//      the same bus. Single seam keeps dispatch-child / orchestrator
//      churn-free for Phase 1; future Phase 4 (Source A — CC harness hooks)
//      will publish into the same `agent.event` topic from an HTTP ingest
//      endpoint, and the same registry + SSE will fan it out.
//
// JSONL persistence is per-session (`session_id` from VOID_OS_SESSION_ID env
// or "default") at `<vaultRoot>/.void/agents/events-<session>.jsonl`. Format
// is one `AgentEvent` per line, matching `hl replay` (VOS-157) input shape:
//   { ts, agent_id, parent_id, kind, summary, ... }
// `hl replay` only requires `{ts, kind, summary}` at minimum; the extra
// fields ride along untouched.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import type { DaemonEvent, EventBus } from "../events/index.ts";
import type { AgentControlState, AgentControlRegistry } from "./control.ts";

// ---------------------------------------------------------------------------
// Schema v1
// ---------------------------------------------------------------------------

export type AgentEventKind =
  | "spawn"        // child task dispatched (bookend start)
  | "tool_call"    // tool_use frame from provider
  | "tool_return"  // tool_result frame from provider
  | "sw_write"     // vault.* MCP write tool returned (subset of tool_return)
  | "status"       // task.state_changed
  | "end"          // run terminated (run.end / child.dispatch_error)
  | "text";        // assistant text chunk (≤200 char summary)

/**
 * Schema v1 — minimum useful payload. Optional fields ride only when the
 * bridge has data; consumers MUST tolerate their absence.
 */
export interface AgentEvent {
  ts: string;                 // ISO8601 UTC
  agent_id: string;           // task id (daemon-side); uuid for future CC hooks
  parent_id: string | null;   // null = root agent
  kind: AgentEventKind;
  summary: string;            // ≤200 char human-readable line
  /** "daemon" today; "cc-hook" once VOS-162 lands. */
  source?: "daemon" | "cc-hook";
  /** Set on kind in {tool_call, tool_return, sw_write}. */
  tool?: string;
  /** Tool call correlator (matches the existing chat.tool_use payload). */
  tool_call_id?: string;
  /** Set on kind=status. */
  state?: string;
  /** Set on kind=end. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface InflightAgent {
  agent_id: string;
  parent_id: string | null;
  task_id: string;        // mirrors agent_id for daemon-side; kept distinct
                          // so Phase 4 cc-hook events (where agent_id is a
                          // uuid) can still carry the underlying task id.
  started_at: string;     // ISO8601 of the spawn (or first observed) event
  current_phase: string;  // most recent kind (or "running")
  last_action: string;    // last summary
  last_summary: string;   // last text/end summary (separate from action)
  last_ts: string;        // most recent event timestamp
  /**
   * VOS-160: bounded ordered event history for this agent. Powers the
   * inspector's click-to-expand "step-by-step trace". Capped at
   * TRACE_CAP newest events — a long-running agent emits thousands of
   * tool_call/tool_return frames and the snapshot must stay bounded.
   */
  trace: AgentEvent[];
  /**
   * VOS-160: true once a terminal (`kind=end`) event arrived. The row is
   * retained for ENDED_GRACE_MS afterwards so the inspector shows the
   * final state before fade-out, then dropped on the next event tick.
   */
  ended: boolean;
  /** Epoch ms the terminal event landed; null while still running. */
  ended_at_ms: number | null;
  /**
   * VOS-161: operator control state for the pause/kill/resume verbs.
   * `running` = no intervention; `paused` = soft-paused at a checkpoint;
   * `killed` = hard-killed. `null` when no live control handle exists
   * (e.g. an ended agent, or a run that pre-dates the control registry).
   * The inspector uses this to gate which verb buttons are shown.
   */
  control_state: AgentControlState | null;
}

const TERMINAL_KINDS: ReadonlySet<AgentEventKind> = new Set(["end"]);

/** Newest-N events retained per agent in the snapshot trace. */
export const TRACE_CAP = 50;

/** How long an ended agent stays visible in the snapshot before drop. */
export const ENDED_GRACE_MS = 10_000;

export interface InflightRegistry {
  list(): InflightAgent[];
  get(agentId: string): InflightAgent | null;
  /** Test-only: drop everything. */
  _reset(): void;
}

export interface InflightRegistryDeps {
  bus: EventBus;
  /** Override clock for tests; defaults to Date.now. */
  now?: () => number;
  /**
   * VOS-161: optional control registry. When set, `list()`/`get()` stamp
   * each row's `control_state` from the live control handle so the
   * inspector can render verb availability. Omitted by Phase-1 tests that
   * don't exercise verbs — those rows carry `control_state: null`.
   */
  control?: AgentControlRegistry;
}

/**
 * Build a registry that updates itself from `agent.event` bus frames. The
 * registry holds an agent row from the first event observed for that id.
 *
 * VOS-160 extends Phase 1's strict drop-on-end behaviour:
 *   - Each row carries a bounded `trace` (newest TRACE_CAP events) so the
 *     inspector can render a step-by-step history per agent.
 *   - A terminal (`kind=end`) event marks the row `ended` with a timestamp
 *     instead of deleting it; the row is purged once it has been ended
 *     longer than ENDED_GRACE_MS. The purge runs lazily on every event
 *     tick (and on `list()`), so no timer is needed.
 */
export function createInflightRegistry(deps: InflightRegistryDeps): InflightRegistry {
  const rows = new Map<string, InflightAgent>();
  const now = deps.now ?? (() => Date.now());

  /** Drop rows that ended longer than the grace window ago. */
  const purgeExpired = (): void => {
    const cutoff = now() - ENDED_GRACE_MS;
    for (const [id, row] of rows) {
      if (row.ended && row.ended_at_ms !== null && row.ended_at_ms < cutoff) {
        rows.delete(id);
      }
    }
  };

  const pushTrace = (row: InflightAgent, ev: AgentEvent): void => {
    row.trace.push(ev);
    if (row.trace.length > TRACE_CAP) {
      row.trace.splice(0, row.trace.length - TRACE_CAP);
    }
  };

  deps.bus.subscribe("agent.event", (ev: DaemonEvent) => {
    const p = ev.payload as AgentEvent | undefined;
    if (!p || typeof p.agent_id !== "string") return;
    purgeExpired();
    let row = rows.get(p.agent_id);
    if (!row) {
      row = {
        agent_id: p.agent_id,
        parent_id: p.parent_id ?? null,
        task_id: p.agent_id,
        started_at: p.ts,
        current_phase: p.kind,
        last_action: p.summary,
        last_summary: p.summary,
        last_ts: p.ts,
        trace: [],
        ended: false,
        ended_at_ms: null,
        control_state: null,
      };
      rows.set(p.agent_id, row);
    } else {
      row.current_phase = p.kind;
      row.last_action = p.summary;
      row.last_ts = p.ts;
      if (p.kind === "text") row.last_summary = p.summary;
    }
    pushTrace(row, p);
    if (TERMINAL_KINDS.has(p.kind)) {
      row.ended = true;
      row.ended_at_ms = now();
      row.last_summary = p.summary;
    }
  });

  // VOS-161: stamp the live control_state onto a row at read time. Kept
  // out of the event handler because the verb routes mutate control state
  // directly on the control registry — reading it lazily keeps the snapshot
  // current without coupling the two registries through the bus.
  const withControlState = (row: InflightAgent): InflightAgent => ({
    ...row,
    control_state: deps.control?.stateOf(row.agent_id) ?? null,
  });

  return {
    list() {
      purgeExpired();
      return Array.from(rows.values())
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
        .map(withControlState);
    },
    get(id) {
      purgeExpired();
      const row = rows.get(id);
      return row ? withControlState(row) : null;
    },
    _reset() {
      rows.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

export interface JsonlWriter {
  write(ev: AgentEvent): void;
  /** Absolute path to the active JSONL file. Stable for the writer's life. */
  readonly path: string;
  close(): void;
}

export interface JsonlWriterOpts {
  vaultRoot: string;
  sessionId: string;
  /** Default true; tests pass false to skip fsync per record. */
  fsync?: boolean;
}

/**
 * Per-session append-only writer. Path is
 *   <vaultRoot>/.void/agents/events-<sessionId>.jsonl
 * Crashed processes leave a partial trailing line; readers (VOS-157 `hl
 * replay`) must tolerate it by ignoring the last line if it has no \n.
 */
export function createJsonlWriter(opts: JsonlWriterOpts): JsonlWriter {
  const dir = path.join(opts.vaultRoot, ".void", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `events-${sanitizeSessionId(opts.sessionId)}.jsonl`);
  let fd: number | null = fs.openSync(filePath, "a");
  const wantFsync = opts.fsync ?? true;
  return {
    path: filePath,
    write(ev) {
      if (fd === null) return;
      const line = JSON.stringify(ev) + "\n";
      fs.writeSync(fd, line);
      if (wantFsync) {
        try { fs.fdatasyncSync(fd); } catch { /* best-effort */ }
      }
    },
    close() {
      if (fd === null) return;
      try { fs.closeSync(fd); } catch { /* swallow */ }
      fd = null;
    },
  };
}

function sanitizeSessionId(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_") || "default";
}

// ---------------------------------------------------------------------------
// Bridge: translate existing bus frames → agent.event
// ---------------------------------------------------------------------------

export interface InflightBridgeDeps {
  bus: EventBus;
  db?: Database;        // currently unused; reserved for parent_id lookup
  /** Truncate `summary` to this many chars. Default 200. */
  summaryCap?: number;
  /** Override timestamp source — tests use this to assert stable strings. */
  now?: () => string;
}

export interface InflightBridge {
  /** Drop all subscriptions. Tests call this to keep buses hermetic. */
  dispose(): void;
}

/**
 * Subscribe to legacy daemon bus topics and re-publish each as
 * `agent.event`. Returns a disposer that unsubscribes everything so tests
 * stay leak-free.
 *
 * Why bridge instead of refactor existing emit sites? Two reasons:
 *   - Phase 1 must not regress existing consumers (WS plugin, SSE CLI,
 *     parent-resume listener, cost subscriber). They all read the legacy
 *     topic names; renaming them is out of scope.
 *   - When Phase 4 lands Source A (CC harness hooks), the cc-hook ingest
 *     handler will emit `agent.event` directly. Keeping that vocabulary
 *     in one place means Source B and Source A share the same wire format
 *     without either source touching the other.
 */
export function createInflightBridge(deps: InflightBridgeDeps): InflightBridge {
  const cap = deps.summaryCap ?? 200;
  const now = deps.now ?? (() => new Date().toISOString());
  const trunc = (s: string): string =>
    s.length <= cap ? s : s.slice(0, cap - 1) + "…";

  function publish(ev: AgentEvent): void {
    deps.bus.emit({ type: "agent.event", payload: ev });
  }

  function taskIdFrom(payload: Record<string, unknown>): string | undefined {
    const t = payload.task_id;
    if (typeof t === "string" && t.length > 0) return t;
    const c = payload.chat_id;
    if (typeof c === "string" && c.length > 0) return c;
    return undefined;
  }

  // VOS-91 chat.tool_use payload: {chat_id, task_id?, run_id, tool_call_id, name, input}
  const offToolUse = deps.bus.subscribe("chat.tool_use", (ev) => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const agentId = taskIdFrom(p);
    if (!agentId) return;
    const tool = typeof p.name === "string" ? (p.name as string) : "";
    publish({
      ts: now(),
      agent_id: agentId,
      parent_id: null,
      kind: "tool_call",
      summary: trunc(`tool_call ${tool}`),
      source: "daemon",
      tool,
      tool_call_id: typeof p.tool_call_id === "string" ? (p.tool_call_id as string) : undefined,
    });
  });

  // chat.tool_result payload: {chat_id, task_id?, run_id, tool_call_id, output, is_error}
  const offToolResult = deps.bus.subscribe("chat.tool_result", (ev) => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const agentId = taskIdFrom(p);
    if (!agentId) return;
    // The tool result frame doesn't carry the tool name (orchestrator + dispatch-child
    // emit only the correlator). For vault.* writes we want `sw_write` kind, but
    // without the name we can't distinguish. Emit generic tool_return; the
    // matching tool_call frame carries the name and Phase 2 consumers can pair
    // them via tool_call_id. Specialised sw_write events ride through the
    // matching chat.tool_use→tool_call below; see VOS-160 for richer pairing.
    publish({
      ts: now(),
      agent_id: agentId,
      parent_id: null,
      kind: "tool_return",
      summary: trunc(p.is_error === true ? "tool_return error" : "tool_return ok"),
      source: "daemon",
      tool_call_id: typeof p.tool_call_id === "string" ? (p.tool_call_id as string) : undefined,
    });
  });

  // chat.token payload: {chat_id, task_id?, run_id, delta}
  const offToken = deps.bus.subscribe("chat.token", (ev) => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const agentId = taskIdFrom(p);
    if (!agentId) return;
    const delta = typeof p.delta === "string" ? (p.delta as string) : "";
    if (delta.length === 0) return;
    publish({
      ts: now(),
      agent_id: agentId,
      parent_id: null,
      kind: "text",
      summary: trunc(delta.replace(/\s+/g, " ").trim() || "text"),
      source: "daemon",
    });
  });

  // task.state_changed payload: {taskId, state} OR {chat_id, run_id, task_id, state}
  const offState = deps.bus.subscribe("task.state_changed", (ev) => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const agentId =
      (typeof p.taskId === "string" ? (p.taskId as string) : undefined) ??
      taskIdFrom(p);
    if (!agentId) return;
    const state = typeof p.state === "string" ? (p.state as string) : "unknown";
    publish({
      ts: now(),
      agent_id: agentId,
      parent_id: null,
      kind: "status",
      summary: trunc(`state ${state}`),
      source: "daemon",
      state,
    });
  });

  // run.end payload: {runId, chatId, agent, taskId, endedAt, ...}
  const offRunEnd = deps.bus.subscribe("run.end", (ev) => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const agentId =
      (typeof p.taskId === "string" ? (p.taskId as string) : undefined) ??
      taskIdFrom(p);
    if (!agentId) return;
    const reason = typeof p.reason === "string" ? (p.reason as string) : "exited";
    publish({
      ts: now(),
      agent_id: agentId,
      parent_id: null,
      kind: "end",
      summary: trunc(`run.end ${reason}`),
      source: "daemon",
      reason,
    });
  });

  // child.dispatch_error payload: {child_task_id, agent_name, error}
  const offDispatchErr = deps.bus.subscribe("child.dispatch_error", (ev) => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const agentId = typeof p.child_task_id === "string" ? (p.child_task_id as string) : undefined;
    if (!agentId) return;
    const err = typeof p.error === "string" ? (p.error as string) : "error";
    publish({
      ts: now(),
      agent_id: agentId,
      parent_id: null,
      kind: "end",
      summary: trunc(`dispatch_error ${err}`),
      source: "daemon",
      reason: "dispatch_error",
    });
  });

  // child.spawn payload: {child_task_id, parent_task_id, agent_name} — emitted
  // by makeDispatchChildTask (see dispatch-child.ts) for explicit bookend.
  const offSpawn = deps.bus.subscribe("child.spawn", (ev) => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const agentId = typeof p.child_task_id === "string" ? (p.child_task_id as string) : undefined;
    if (!agentId) return;
    const parentId = typeof p.parent_task_id === "string" ? (p.parent_task_id as string) : null;
    const name = typeof p.agent_name === "string" ? (p.agent_name as string) : "child";
    publish({
      ts: now(),
      agent_id: agentId,
      parent_id: parentId,
      kind: "spawn",
      summary: trunc(`spawn ${name}`),
      source: "daemon",
    });
  });

  return {
    dispose() {
      offToolUse();
      offToolResult();
      offToken();
      offState();
      offRunEnd();
      offDispatchErr();
      offSpawn();
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence wiring helper
// ---------------------------------------------------------------------------

/** Wire JSONL persistence: every `agent.event` is appended to the writer. */
export function attachJsonlPersistence(
  bus: EventBus,
  writer: JsonlWriter,
): () => void {
  return bus.subscribe("agent.event", (ev) => {
    const p = ev.payload as AgentEvent | undefined;
    if (!p) return;
    try {
      writer.write(p);
    } catch (err) {
      // Persistence failure must not poison the bus. Surface once via console;
      // VOS-160 plugin view doesn't depend on disk reads.
      console.warn("[inflight] jsonl write failed:", (err as Error).message);
    }
  });
}
