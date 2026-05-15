/**
 * VOS-79 T9: bridge between the bus-emitting `CcSpawner` (T5/T7) and the
 * narrow `AsyncIterable<SpawnerEvent>` contract the orchestrator (T7) expects.
 *
 * The real `CcSpawner.spawn(req)` returns `Promise<CcProcess>` and pushes
 * parsed stdout JSONL events onto the bus as `cc.event` payloads. The
 * orchestrator wants `for await (const evt of stream)` where each `evt` is a
 * parsed claudev stream record (`{type:"system",session_id,...}`,
 * `{type:"assistant",content,...}`, etc.).
 *
 * This adapter:
 *   1. Subscribes to `cc.event`, `run.end`, `run.error` on the bus BEFORE
 *      calling `cc.spawn` — events buffered while our `runId` is unknown.
 *   2. Awaits `cc.spawn(...)`, captures `proc.runId` from the result.
 *   3. Drains the pre-spawn buffer, filtering by `runId`.
 *   4. Yields matching events via a queue + Promise-based wake signal
 *      (single waiter per iterator; backpressure-safe because the orchestrator
 *      synchronously processes each event before requesting the next).
 *   5. Cleans up subscriptions in `finally`.
 *
 * Error semantics: `run.error` → throws inside the iterator (matches
 * orchestrator's existing try/catch around `for await`). Graceful `run.end`
 * (status === "done" / "exited") → iterator drains remaining events then
 * returns. The orchestrator wraps the iterator in its own try/catch/finally,
 * so a thrown error here becomes a `run.error` bus emit at the chat layer.
 */

import type { CcSpawner, KillOpts } from "./index.js";
import type { EventBus, DaemonEvent } from "../../events/index.js";
import type {
  ProviderEvent as SpawnerEvent,
  ProviderSpawnRequest,
} from "../types.ts";

// Local alias kept for one transition step; Task 5 removes references.
type SpawnArgs = {
  chat_id: string;
  resume: string | null;
  prompt: string;
};

// Local Spawner interface kept for the iterator-style return type. Task 5
// retires it when `makeClaudeCodeProvider` replaces it as the public surface.
interface Spawner {
  spawn(args: SpawnArgs): AsyncIterable<SpawnerEvent>;
  cancel?(runId: string): Promise<boolean>;
}

export interface SpawnerIterDeps {
  /** Underlying bus-emitting spawner (createCcSpawner output). */
  cc: CcSpawner;
  /** Same bus the underlying spawner emits into. */
  bus: EventBus;
  /** Static fields the underlying spawner needs that the orchestrator does
   *  not supply (agent name, cwd). Per-dispatch values (prompt, chat_id,
   *  resumeFrom) come from `SpawnArgs`. */
  agent: string;
  cwd: string;
}

/**
 * Build a `Spawner` (orchestrator-shaped) backed by a bus-emitting `CcSpawner`.
 *
 * VOS-80 S5: `cancel(runId)` is wired to the matching `CcProcess.kill()`.
 * A shared per-iter map (`activeProcs`) tracks live runs; the orchestrator
 * looks the runId up via this adapter, the adapter forwards SIGINT (with
 * 250ms SIGKILL grace) via `kill({fast: true})` to the subprocess. The
 * iterator's bus subscription receives the resulting `run.end` and
 * naturally drains.
 *
 * Why SIGINT not SIGTERM: CC (anthropic-ai/claude CLI) traps SIGTERM and
 * gracefully flushes the in-flight response stream before exiting, so a
 * SIGTERM-based cancel lets the entire reply keep arriving for several
 * seconds after the user pressed ESC. SIGINT mimics Ctrl-C and aborts
 * immediately. Watchdog timeouts keep the SIGTERM-5s-SIGKILL path so
 * naturally-stuck runs still get a chance to flush.
 */
export function makeCcSpawnerIter(deps: SpawnerIterDeps): Spawner {
  // Per-spawner-instance map. Multiple chats running in parallel have
  // distinct runIds; cancel(runId) only touches the one. Populated by
  // iterate() once cc.spawn resolves; cleared when the iterator's finally
  // block runs (run.end or run.error or cancel-induced kill).
  const activeProcs = new Map<string, { kill: (opts?: KillOpts) => Promise<void> }>();
  return {
    spawn(args: SpawnArgs): AsyncIterable<SpawnerEvent> {
      return iterate(deps, args, activeProcs);
    },
    async cancel(runId: string): Promise<boolean> {
      const proc = activeProcs.get(runId);
      if (!proc) return false;
      // Fire-and-forget: kill resolves only after the process exits, but
      // we don't want to block the HTTP handler that long. The iterator's
      // bus subscription will fire run.end → finally → activeProcs.delete.
      proc.kill({ fast: true }).catch(() => {});
      return true;
    },
  };
}

/**
 * One iterator per dispatch. Holds its own queue + subscription handles so
 * concurrent dispatches on different chats don't cross-contaminate (the bus
 * is global; the filter is per-iterator runId).
 */
async function* iterate(
  deps: SpawnerIterDeps,
  args: SpawnArgs,
  activeProcs: Map<string, { kill: (opts?: KillOpts) => Promise<void> }>,
): AsyncGenerator<SpawnerEvent, void, void> {
  const queue: SpawnerEvent[] = [];
  // Buffer for events that arrive before `cc.spawn` resolves (i.e. before
  // we know our `runId`). Drained + filtered after spawn resolves.
  const preSpawn: DaemonEvent[] = [];
  let runId: string | null = null;
  let done = false;
  let error: Error | null = null;
  // Set to true when run.end carries reason="timeout" so the iterator can
  // throw a CC_TIMEOUT sentinel instead of exhausting cleanly.
  let timedOut = false;
  // Single-waiter wake signal: each pull awaits `wait`; producer resolves
  // it via `wake()` and rotates the slot. Safe because async generators
  // serialise pulls (no concurrent `next()` calls on the same iterator).
  let wake: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  // Push an event into the queue ONLY if it matches our run. If runId is
  // not yet known, buffer the whole DaemonEvent and resolve later.
  const onCcEvent = (e: DaemonEvent) => {
    if (runId === null) {
      preSpawn.push(e);
      return;
    }
    if (e.runId !== runId) return;
    const inner = (e.payload as { event?: SpawnerEvent } | undefined)?.event;
    if (inner) {
      queue.push(inner);
      signal();
    }
  };
  const onRunEnd = (e: DaemonEvent) => {
    if (runId === null) {
      preSpawn.push(e);
      return;
    }
    if (e.runId !== runId) return;
    // Surface watchdog timeout: run.end with reason="timeout" must become a
    // CC_TIMEOUT sentinel throw so provider.ts can resolve reason:"timeout".
    const reason = (e.payload as { reason?: string } | undefined)?.reason;
    if (reason === "timeout") timedOut = true;
    done = true;
    signal();
  };
  const onRunError = (e: DaemonEvent) => {
    if (runId === null) {
      preSpawn.push(e);
      return;
    }
    if (e.runId !== runId) return;
    const err = (e.payload as { error?: unknown } | undefined)?.error;
    error = err instanceof Error ? err : new Error(String(err ?? "spawn error"));
    done = true;
    signal();
  };

  const unsubEvent = deps.bus.subscribe("cc.event", onCcEvent);
  const unsubEnd = deps.bus.subscribe("run.end", onRunEnd);
  const unsubErr = deps.bus.subscribe("run.error", onRunError);

  try {
    // Translate orchestrator SpawnArgs → CcSpawnRequest. Note: orchestrator
    // passes `resume` (string | null); cc wants `resumeFrom` (string | undef).
    const proc = await deps.cc.spawn({
      prompt: args.prompt,
      agent: deps.agent,
      cwd: deps.cwd,
      chatId: args.chat_id,
      kind: "chat",
      resumeFrom: args.resume ?? undefined,
    });
    runId = proc.runId;
    // Register for VOS-80 cancel: the spawner's `cancel(runId)` looks this
    // entry up and forwards to `CcProcess.kill()`.
    activeProcs.set(runId, { kill: (opts?: KillOpts) => proc.kill(opts) });

    // Drain pre-spawn buffer: any event whose runId matches retroactively
    // fires through the same handlers. This is the race window between
    // cc.spawn issuing emits synchronously inside its async body and the
    // await here resolving.
    for (const e of preSpawn) {
      if (e.runId !== runId) continue;
      if (e.type === "cc.event") {
        const inner = (e.payload as { event?: SpawnerEvent } | undefined)?.event;
        if (inner) queue.push(inner);
      } else if (e.type === "run.end") {
        const reason = (e.payload as { reason?: string } | undefined)?.reason;
        if (reason === "timeout") timedOut = true;
        done = true;
      } else if (e.type === "run.error") {
        const err = (e.payload as { error?: unknown } | undefined)?.error;
        error = err instanceof Error ? err : new Error(String(err ?? "spawn error"));
        done = true;
      }
    }
    preSpawn.length = 0;

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) {
        if (error) throw error;
        if (timedOut) {
          throw Object.assign(new Error("watchdog timeout"), { code: "CC_TIMEOUT" });
        }
        return;
      }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    unsubEvent();
    unsubEnd();
    unsubErr();
    if (runId !== null) activeProcs.delete(runId);
  }
}
