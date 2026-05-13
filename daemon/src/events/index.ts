// Event recorder. Writes to SQLite + JSONL traces. Pub/sub for live SSE.

export interface DaemonEvent {
  type: string;
  runId?: string;
  chatId?: string;
  payload: unknown;
  ts?: number;
}

export interface EventBus {
  emit(event: DaemonEvent): void;
  subscribe(type: string, handler: (event: DaemonEvent) => void): () => void;
  query(filter: { since?: number; type?: string }): Promise<DaemonEvent[]>;
}

export const createEventBus = (): EventBus => {
  throw new Error("not implemented");
};
