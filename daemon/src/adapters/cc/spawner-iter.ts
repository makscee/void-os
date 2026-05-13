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

import type { CcSpawner } from "./index.js";
import type { EventBus, DaemonEvent } from "../../events/index.js";
import type {
  Spawner,
  SpawnArgs,
  SpawnerEvent,
} from "../../chat/orchestrator.js";

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
 */
export function makeCcSpawnerIter(deps: SpawnerIterDeps): Spawner {
  return {
    spawn(args: SpawnArgs): AsyncIterable<SpawnerEvent> {
      return iterate(deps, args);
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
): AsyncGenerator<SpawnerEvent, void, void> {
  const queue: SpawnerEvent[] = [];
  // Buffer for events that arrive before `cc.spawn` resolves (i.e. before
  // we know our `runId`). Drained + filtered after spawn resolves.
  const preSpawn: DaemonEvent[] = [];
  let runId: string | null = null;
  let done = false;
  let error: Error | null = null;
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
        return;
      }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    unsubEvent();
    unsubEnd();
    unsubErr();
  }
}
