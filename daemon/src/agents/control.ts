// VOS-161: agent control registry — the two-verb intervention model.
//
// VOS-155 baked decision (2026-05-20T11:16:59Z): "soft pause + hard kill as
// separate verbs. Pause = wait-for-checkpoint (no torn state). Kill =
// interrupt + record abort."
//
// This module owns the daemon-side control plane the inspector verbs drive:
//
//   - `AgentControlRegistry` — a `Map<agent_id, AgentControlHandle>`. A
//     running child registers a handle on spawn (dispatch-child.ts) and
//     deregisters it when the run reaches a terminal state.
//
//   - `AgentControlHandle` — the per-agent control surface. The HTTP verb
//     routes call `requestPause/requestResume/requestKill`; the child run
//     loop calls `awaitCheckpoint()` between provider frames so a pending
//     pause parks the run at a clean boundary (no torn tool call).
//
// Soft pause semantics: `requestPause()` flips an internal flag only. The
// run loop is what actually parks — it awaits `awaitCheckpoint()` at each
// frame boundary, which resolves immediately when not paused and otherwise
// returns a promise that settles on the next `requestResume()`. This keeps
// "wait-for-checkpoint" honest: the run never stops mid-frame.
//
// Hard kill semantics: `requestKill()` aborts an `AbortController` the run
// loop wired into `drainRun`'s `signal`. drainRun's abort path calls
// `handle.cancel()` → SIGINT to the CC subprocess. The kill is also recorded
// as the control state so a parked (paused) run that is then killed still
// terminates.

export type AgentControlState = "running" | "paused" | "killed";

export interface AgentControlHandle {
  /** Current control state. */
  state(): AgentControlState;
  /** Verb: request a soft pause. No-op if already paused or killed. */
  requestPause(): void;
  /** Verb: clear a pause. No-op if not paused. Wakes a parked run. */
  requestResume(): void;
  /** Verb: hard kill. Aborts the run + records the abort. Idempotent. */
  requestKill(): void;
  /**
   * Run-loop checkpoint. Resolves immediately when running; when paused,
   * returns a promise that settles on the next resume (or kill). The child
   * run loop awaits this between provider frames.
   */
  awaitCheckpoint(): Promise<void>;
}

export interface AgentControlRegistry {
  /**
   * Register a control handle for a running agent. `onKill` is invoked the
   * first time the agent is killed — dispatch-child wires it to its
   * AbortController. Returns the handle (also retrievable via `get`).
   */
  register(agentId: string, onKill: () => void): AgentControlHandle;
  /** Drop the handle for a terminated agent. No-op if absent. */
  deregister(agentId: string): void;
  /** The live handle for an agent, or null if unknown / already terminal. */
  get(agentId: string): AgentControlHandle | null;
  /** Control state for the snapshot; null when no handle exists. */
  stateOf(agentId: string): AgentControlState | null;
  /** Test-only: drop everything. */
  _reset(): void;
}

export function createAgentControlRegistry(): AgentControlRegistry {
  const handles = new Map<string, AgentControlHandle>();

  function makeHandle(onKill: () => void): AgentControlHandle {
    let state: AgentControlState = "running";
    // Resolver for the promise a parked run is awaiting. Null when running.
    let wake: (() => void) | null = null;

    const settleWake = (): void => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };

    return {
      state() {
        return state;
      },
      requestPause() {
        if (state === "running") state = "paused";
      },
      requestResume() {
        if (state === "paused") {
          state = "running";
          settleWake();
        }
      },
      requestKill() {
        if (state === "killed") return;
        state = "killed";
        // Wake any parked run so it stops awaiting and proceeds to abort.
        settleWake();
        try {
          onKill();
        } catch {
          // onKill is a best-effort abort trigger; never let it throw
          // back into a verb HTTP handler.
        }
      },
      awaitCheckpoint() {
        if (state !== "paused") return Promise.resolve();
        // Park: resolve when resume (or kill) calls settleWake.
        return new Promise<void>((resolve) => {
          wake = resolve;
        });
      },
    };
  }

  return {
    register(agentId, onKill) {
      const handle = makeHandle(onKill);
      handles.set(agentId, handle);
      return handle;
    },
    deregister(agentId) {
      handles.delete(agentId);
    },
    get(agentId) {
      return handles.get(agentId) ?? null;
    },
    stateOf(agentId) {
      return handles.get(agentId)?.state() ?? null;
    },
    _reset() {
      handles.clear();
    },
  };
}
