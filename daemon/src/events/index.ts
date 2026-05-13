// Event recorder. Writes to SQLite + JSONL traces (caller handles JSONL).
// Pub/sub for live SSE handled in-process via Map<type, Set<handler>>.

import type { Database } from "bun:sqlite";

export interface DaemonEvent {
  type: string;
  runId?: string;
  chatId?: string;
  payload: unknown;
  ts?: number;
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
  db: Database;
  logger?: (msg: string, err: unknown) => void;
}

export const createEventBus = (deps: Deps): EventBus => {
  const { db } = deps;
  const log = deps.logger ?? ((msg, err) => console.error(`[events] ${msg}:`, err));
  const subs = new Map<string, Set<(e: DaemonEvent) => void>>();
  const insert = db.prepare(
    "INSERT INTO events (ts, type, run_id, chat_id, agent, data) VALUES (?, ?, ?, ?, NULL, ?)",
  );

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
      insert.run(ts, event.type, event.runId ?? null, event.chatId ?? null, JSON.stringify(event.payload ?? {}));
      dispatch(event.type, { ...event, ts });
    },
    subscribe(type, handler) {
      let set = subs.get(type);
      if (!set) { set = new Set(); subs.set(type, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
    async query(filter) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.type)  { where.push("type = ?");    params.push(filter.type); }
      if (filter.runId) { where.push("run_id = ?");  params.push(filter.runId); }
      if (filter.since !== undefined) { where.push("ts >= ?"); params.push(filter.since); }
      const sql = `SELECT ts, type, run_id, chat_id, data FROM events ${
        where.length ? "WHERE " + where.join(" AND ") : ""
      } ORDER BY id ASC`;
      const rows = db.prepare(sql).all(...params) as Array<{
        ts: number; type: string; run_id: string | null; chat_id: string | null; data: string;
      }>;
      return rows.map((r) => ({
        ts: r.ts,
        type: r.type,
        runId: r.run_id ?? undefined,
        chatId: r.chat_id ?? undefined,
        payload: JSON.parse(r.data) as unknown,
      }));
    },
  };
};
