// In-process pub/sub event bus. SQLite persistence was removed in
// VOS-83 / migration 0007 — the legacy `events` table is dropped there.
// emit() fans out to subscribers; persistence/query removed in VOS-102.

import type { Database } from "bun:sqlite";

export interface DaemonEvent {
  type: string;
  runId?: string;
  chatId?: string;
  payload: unknown;
  ts?: number;
}

export interface UsageTurn {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  model: string;
  provider: string;   // VOS-87: stamped by orchestrator from Provider.name
}

export interface RunEndEvent extends DaemonEvent {
  type: "run.end";
  runId: string;
  chatId: string;
  payload: {
    agent: string;
    endedAt: number;
    usageTurns: UsageTurn[];
    taskId: string | null;   // VOS-87: orchestrator reads from runs row
    // VOS-87 T4: legacy fields preserved additively so existing
    // consumers (status flips, e2e tests, watchdog plumbing) keep
    // compiling. cc-spawner (the sole live bus emit site) populates
    // all of these; downstream consumers that only care about cost
    // can ignore them. Optional only because some future provider
    // may not have them (e.g. an HTTP-based provider with no exit
    // code); the cc-spawner always sets them.
    exitCode?: number;
    durationMs?: number;
    reason?: "exited" | "timeout" | "killed";
  };
}

export interface EventBus {
  emit(event: DaemonEvent): void;
  subscribe(type: string, handler: (event: DaemonEvent) => void): () => void;
}

interface Deps {
  db?: Database;
  logger?: (msg: string, err: unknown) => void;
}

export const createEventBus = (deps: Deps = {}): EventBus => {
  const log = deps.logger ?? ((msg, err) => console.error(`[events] ${msg}:`, err));
  const subs = new Map<string, Set<(e: DaemonEvent) => void>>();

  const dispatch = (type: string, event: DaemonEvent): void => {
    for (const t of [type, "*"]) {
      const set = subs.get(t);
      if (!set) continue;
      for (const h of set) {
        try { h(event); } catch (err) { log(`handler for "${t}"`, err); }
      }
    }
  };

  return {
    emit(event) {
      const ts = event.ts ?? Date.now();
      dispatch(event.type, { ...event, ts });
    },
    subscribe(type, handler) {
      let set = subs.get(type);
      if (!set) { set = new Set(); subs.set(type, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
  };
};
