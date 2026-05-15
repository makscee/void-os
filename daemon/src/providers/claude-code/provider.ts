import type {
  Provider,
  ProviderEvent,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../types.ts";

// Internal shape of the existing iterator-style spawner. Decoupled here so
// callers (tests + app.ts) supply concrete impls. Production wiring in
// providers/claude-code/index.ts injects `makeCcSpawnerIter(createCcSpawner(...))`.
export interface CcIter {
  spawn(args: {
    chat_id: string;
    resume: string | null;
    prompt: string;
  }): AsyncIterable<ProviderEvent>;
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
        chat_id: req.chatId ?? "",
        resume: req.resumeFrom ?? null,
        prompt: req.prompt,
      });

      async function* events(): AsyncIterable<ProviderEvent> {
        try {
          for await (const e of raw) {
            if (e.type === "system" && typeof e.session_id === "string") {
              sessionId = e.session_id;
            }
            yield e;
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
