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
    resume: string | null;
    prompt: string;
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
        resume: req.resumeFrom ?? null,
        prompt: req.prompt,
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
