// VOS-147: per-run registry that bridges CC's `toolu_*` tool_use id (emitted
// in the model stream and propagated to the plugin via `chat.tool_use`) with
// the MCP `tools/call` handler (which currently mints a fresh UUID for its
// bridge slot, causing first-try /answer to 409 because the plugin uses CC's
// id but the bridge keyed the slot by its UUID).
//
// Orchestrator: when its onPart sees a tool_use part with name=ask_user (or
// the raw CC-emitted form mcp__void-os__ask_user), call set(taskId, runId,
// toolUseId). The write is synchronous and happens as part of CC stream
// processing, BEFORE the MCP request typically arrives.
//
// ask-user.ts MCP handler: await take(taskId, runId, timeoutMs). Returns the
// stored id if available within the timeout; null otherwise (handler falls
// back to randomUUID, preserving legacy behavior + test infra hint).
//
// In-process only. Module-scoped Map; no persistence.

interface Entry {
  toolUseId: string;
  /** Resolved when set() is called. Awaiters subscribe here so the order
   *  CC-stream-processing vs MCP-call-arrival doesn't matter. */
  resolve: () => void;
}

const _registry = new Map<string, Entry>();

function key(taskId: string): string {
  return taskId;
}

/** Orchestrator-side: record CC's tool_use id for an in-flight ask_user.
 *  Keyed by taskId only: ask_user blocks the task until /answer resolves,
 *  so at most one open prompt per task at a time. (Orchestrator's per-turn
 *  runId differs from the spawn-time VOS_RUN_ID seen by ask-user.ts in
 *  later turns, so runId is NOT a reliable correlator.)
 *  Idempotent: a second set replaces the prior id and resolves any awaiter. */
export function setPendingAskUserToolUseId(
  taskId: string,
  _runIdUnused: string | null | undefined,
  toolUseId: string,
): void {
  const k = key(taskId);
  const prev = _registry.get(k);
  if (prev) {
    prev.toolUseId = toolUseId;
    prev.resolve();
    return;
  }
  // No awaiter yet — store a sentinel entry. The future awaiter (if any)
  // will see the id immediately on take().
  _registry.set(k, { toolUseId, resolve: () => {} });
}

/** MCP-handler-side: consume the stored id, waiting up to `timeoutMs` for
 *  the orchestrator to set it. Returns null on timeout. The entry is
 *  always cleared after this returns (success or timeout). */
export async function takePendingAskUserToolUseId(
  taskId: string,
  _runIdUnused: string | null | undefined,
  timeoutMs: number,
): Promise<string | null> {
  const k = key(taskId);
  const existing = _registry.get(k);
  if (existing) {
    _registry.delete(k);
    return existing.toolUseId;
  }
  // Wait. Install an awaiter that the orchestrator's set() will resolve.
  return await new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      _registry.delete(k);
      resolve(id);
    };
    _registry.set(k, {
      toolUseId: "",
      resolve: () => {
        const cur = _registry.get(k);
        finish(cur?.toolUseId.length ? cur.toolUseId : null);
      },
    });
    setTimeout(() => finish(null), timeoutMs);
  });
}

/** Test helper: clear all entries. */
export function _resetForTests(): void {
  _registry.clear();
}
