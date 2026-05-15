/**
 * Fake Provider — deterministic event-stream replayer for e2e tests.
 *
 * Reads JSONL from `scriptPath`. Each line is parsed as a ProviderEvent and
 * yielded in order. No child process. No network. No SDK. Used by `plugin/e2e/`
 * when `VOS_PROVIDER=fake` is set (selected by the provider factory).
 */
import { readFile } from "node:fs/promises";
import type {
  Provider,
  ProviderEvent,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../types.ts";

export interface FakeProviderOpts {
  scriptPath: string;
  /** Optional delay between events. Default 0. Useful for cancel tests. */
  perEventDelayMs?: number;
}

export function makeFakeProvider(opts: FakeProviderOpts): Provider {
  const scriptPath = opts.scriptPath;
  const perEventDelayMs = opts.perEventDelayMs ?? 0;
  return {
    name: "fake",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let cancelled = false;
      let resolveDone!: (r: { exitCode?: number; sessionId?: string; reason: "exit" | "cancel" | "timeout" | "error" }) => void;
      const done = new Promise<{ exitCode?: number; sessionId?: string; reason: "exit" | "cancel" | "timeout" | "error" }>((res) => {
        resolveDone = res;
      });
      let sessionId: string | undefined;

      async function* gen(): AsyncGenerator<ProviderEvent> {
        let raw: string;
        try {
          raw = await readFile(scriptPath, "utf8");
        } catch (err) {
          resolveDone({ reason: "error" });
          return;
        }
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          if (cancelled) { resolveDone({ reason: "cancel" }); return; }
          let ev: ProviderEvent;
          try { ev = JSON.parse(line) as ProviderEvent; }
          catch { resolveDone({ reason: "error" }); return; }
          if (ev.type === "system" && typeof ev.session_id === "string") {
            sessionId = ev.session_id;
          }
          yield ev;
          if (perEventDelayMs > 0) await new Promise((r) => setTimeout(r, perEventDelayMs));
        }
        resolveDone({ reason: "exit", exitCode: 0, sessionId });
      }

      return {
        events: gen(),
        async cancel() {
          if (cancelled) return false;
          cancelled = true;
          return true;
        },
        done,
      };
    },
  };
}
