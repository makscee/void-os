// VOS-162 Source A: best-effort hook → daemon event poster.
//
// The PreToolUse / PostToolUse hook scripts call this to push a CC harness
// event into the daemon's `/agents/hook-event` ingest. Two hard rules:
//
//   1. NEVER throws. A hook script's job is the permission decision (or a
//      no-op pass-through); event ingestion is observability garnish. If
//      the daemon is unreachable, mid-restart, or returns an error, the
//      hook must still emit its decision and exit 0.
//   2. NEVER blocks meaningfully. A short timeout caps the fire-and-forget
//      POST so a wedged daemon can't stall every tool call.
//
// Identity: `VOS_HOOK_AGENT_ID` (set by buildSpawnSettings → the task id
// the inflight registry keys on) makes Source-A events correlate with the
// same agent_id Source B emits — that is what makes the stream a *union*.

export interface HookEventInput {
  /** "tool_call" (PreToolUse) | "tool_return" (PostToolUse). */
  kind: "tool_call" | "tool_return";
  /** Tool name, e.g. "Bash" / "Edit". */
  tool?: string;
  /** ≤200-char human line for the inspector trace. */
  summary: string;
}

const POST_TIMEOUT_MS = 800;

/**
 * Fire-and-forget POST of a hook event to the daemon. Resolves true on a
 * 2xx, false otherwise — callers ignore the result; it exists only for
 * tests. Never rejects.
 */
export async function postHookEvent(
  input: HookEventInput,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const base = env.VOS_DAEMON_BASE;
  const agentId = env.VOS_HOOK_AGENT_ID;
  // No daemon base or agent identity → nothing to correlate against.
  // Silently skip (e.g. a hook spawned outside the daemon's spawn path).
  if (!base || !agentId) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${base}/agents/hook-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        agent_id: agentId,
        parent_id: env.VOS_HOOK_PARENT_ID ?? null,
        kind: input.kind,
        tool: input.tool,
        summary: input.summary.slice(0, 200),
      }),
    });
    return res.ok;
  } catch {
    // Daemon unreachable / timeout / abort — observability loss only.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
