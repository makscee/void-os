import type {
  CanonicalProviderEvent,
  LegacyProviderEvent,
  Provider,
  ProviderEvent,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../types.ts";
import { normalizeCcEvent } from "./cc-shape.ts";

// VOS-96: the CC spawner iterator still emits raw CC wire-format frames.
// `CcIter` is the pre-normalization seam; provider.ts runs each frame
// through `normalizeCcEvent` before yielding the canonical event downstream.
type RawCcEvent = LegacyProviderEvent;

// Internal shape of the existing iterator-style spawner. Decoupled here so
// callers (tests + app.ts) supply concrete impls. Production wiring in
// providers/claude-code/index.ts injects `makeCcSpawnerIter(createCcSpawner(...))`.
export interface CcIter {
  spawn(args: {
    chat_id: string;
    task_id: string;          // VOS-112
    resume: string | null;
    prompt: string;
    /** VOS-122 F9: per-call agent overrides the spawner's static deps.agent
     *  fallback. When set, the underlying cc.spawn receives this name so the
     *  CC subprocess loads the requested agent's card + scopes — not the
     *  daemon-wide `defaultAgent` (which previously pinned every chat to
     *  "maya" regardless of `chat.agent`). */
    agent?: string;
  }): AsyncIterable<RawCcEvent>;
  cancel?(runId: string): Promise<boolean>;
}

export interface MakeClaudeCodeProviderDeps {
  iter: CcIter;
}

export function makeClaudeCodeProvider(
  deps: MakeClaudeCodeProviderDeps,
): Provider {
  return {
    name: "claude-code",
    spawn(req: ProviderSpawnRequest): ProviderHandle {
      type Reason = "exit" | "cancel" | "timeout" | "error";
      let resolveDone!: (
        v: { exitCode?: number; sessionId?: string; reason: Reason },
      ) => void;
      const done = new Promise<{
        exitCode?: number;
        sessionId?: string;
        reason: Reason;
      }>((r) => (resolveDone = r));

      let ended = false;
      let cancelled = false;
      let sessionId: string | undefined;

      const raw = deps.iter.spawn({
        // VOS-96 T10: ProviderSpawnRequest tightened — `chatId` removed in
        // favor of the required `contextId` (chat-shaped runs set
        // contextId = chatId at the orchestrator seam).
        chat_id: req.contextId,
        task_id: req.taskId,
        resume: req.resumeFrom ?? null,
        prompt: req.prompt,
        // VOS-122 F9: forward the requested agent so the CC subprocess loads
        // the right card. Without this every chat span resolved to the
        // daemon-wide `defaultAgent` ("maya"), which doesn't exist in starter
        // vaults → "unknown agent: maya" at agent_cards lookup.
        agent: req.agent,
      });

      async function* events(): AsyncIterable<ProviderEvent> {
        try {
          for await (const e of raw) {
            // VOS-96 T3: normalize raw CC frames into canonical `ProviderEvent`s
            // per ADR-0001 §Decision. The upstream spawner yields legacy CC
            // shape; we translate on the seam so consumers (orchestrator,
            // dispatch-child) see only `SessionEvent | PartsEvent`.
            const canonical: CanonicalProviderEvent | null = normalizeCcEvent(e);
            if (canonical === null) {
              // Non-canonical frames (e.g. CC `{type:"result"}` terminal
              // sentinels) have no consumer-facing equivalent — drop.
              if (cancelled) break;
              continue;
            }
            if (canonical.type === "session") {
              sessionId = canonical.sessionId;
            }
            yield canonical;
            if (cancelled) break;
          }
          if (!ended) {
            ended = true;
            resolveDone({
              reason: cancelled ? "cancel" : "exit",
              sessionId,
            });
          }
        } catch (err) {
          if (!ended) {
            ended = true;
            // Typed timeout sentinel: spawner.ts throws with code "CC_TIMEOUT"
            // when the underlying iterator surfaces a watchdog termination.
            const isTimeout =
              err instanceof Error &&
              (err as Error & { code?: string }).code === "CC_TIMEOUT";
            resolveDone({
              reason: isTimeout ? "timeout" : cancelled ? "cancel" : "error",
              sessionId,
            });
          }
          throw err;
        }
      }

      return {
        events: events(),
        async cancel(_opts) {
          if (ended) return false;
          cancelled = true;
          if (deps.iter.cancel) {
            try {
              await deps.iter.cancel(req.runId);
            } catch {
              // swallow — termination of the iterator drives `done`
            }
          }
          return true;
        },
        done,
      };
    },
  };
}
