// VOS-164: live-agent registry — the authoritative set of agent_ids the
// daemon has actually spawned and that still have a running CC subprocess.
//
// Why this exists: POST /agents/hook-event (the Source-A CC harness hook
// ingest, VOS-162) is an un-authed loopback route. Without a correlation
// check, any host-local process could POST forged `agent.event` rows onto an
// arbitrary agent_id trace. The hook-event endpoint consults this registry
// and rejects events for an agent_id the daemon never spawned.
//
// Why not the existing registries:
//   - `InflightRegistry` is built FROM the event stream — a forged event
//     would create its own row, so it cannot vouch for an agent_id.
//   - `AgentControlRegistry` only tracks *dispatched child* agents
//     (dispatch-child.ts registers a handle); a top-level chat agent never
//     registers one, so it would wrongly reject legitimate chat-agent hooks.
//
// The CC spawner is the single chokepoint: every CC subprocess — top-level
// chat run OR dispatched child — flows through `createCcSpawner().spawn()`,
// which sets `VOS_HOOK_AGENT_ID = req.taskId`. The spawner registers that
// task id here the moment the subprocess starts and unregisters it when the
// run finalizes. The agent_id a Source-A hook posts is exactly that task id.

export interface LiveAgentRegistry {
  /** Record that the daemon spawned a CC subprocess for this agent_id. */
  register(agentId: string): void;
  /** Drop the agent_id once its run has finalized. No-op if absent. */
  unregister(agentId: string): void;
  /** True iff the daemon currently has a live run for this agent_id. */
  has(agentId: string): boolean;
  /** Count of live agents — for diagnostics / tests. */
  size(): number;
  /** Test-only: drop everything. */
  _reset(): void;
}

/**
 * Build an in-memory live-agent registry. A single instance is shared
 * (via `buildApp`) between the CC spawner — which registers/unregisters as
 * runs start and finalize — and the hook-event ingest route, which reads
 * `has()` to gate incoming Source-A events.
 *
 * `register` is idempotent and ref-counted: a single agent_id can host
 * sequential runs (a chat agent resumed across turns) without one run's
 * finalize prematurely unregistering an id another run still holds.
 */
export function createLiveAgentRegistry(): LiveAgentRegistry {
  // Ref-count rather than a plain Set: the same task id can be spawned more
  // than once (e.g. a chat agent's successive turns, or a resume). The id
  // stays live until every run that registered it has finalized.
  const refs = new Map<string, number>();

  return {
    register(agentId) {
      if (typeof agentId !== "string" || agentId.length === 0) return;
      refs.set(agentId, (refs.get(agentId) ?? 0) + 1);
    },
    unregister(agentId) {
      const n = refs.get(agentId);
      if (n === undefined) return;
      if (n <= 1) refs.delete(agentId);
      else refs.set(agentId, n - 1);
    },
    has(agentId) {
      return refs.has(agentId);
    },
    size() {
      return refs.size;
    },
    _reset() {
      refs.clear();
    },
  };
}
