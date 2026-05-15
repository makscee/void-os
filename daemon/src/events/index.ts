// In-process pub/sub event bus. SQLite persistence was removed in
// VOS-83 / migration 0007 — the legacy `events` table is dropped there.
// emit() still fans out to subscribers; query() is a no-op stub kept
// for interface compatibility until callers are removed.

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
}

export interface RunEndEvent extends DaemonEvent {
  type: "run.end";
  runId: string;
  chatId: string;
  payload: {
    agent: string;
    endedAt: number;
    usageTurns: UsageTurn[];
  };
}

export interface EventQuery {
  since?: number;
  type?: string;
  runId?: string;
}

export interface EventBus {
  emit(event: DaemonEvent): void;
  subscribe(type: string, handler: (event: DaemonEvent) => void): () => void;
  query(filter: EventQuery): Promise<DaemonEvent[]>;
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
    async query(_filter) {
      // Persistence removed in VOS-83. The `events` table no longer exists.
      return [];
    },
  };
};
