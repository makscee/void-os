// daemon/src/trace/types.ts

export type TraceKind =
  | "turn.start"
  | "turn.end"
  | "cc.event"
  | "cc.stderr"
  | "tool.call"
  | "tool.result"
  | "error";

export interface TraceRecord {
  seq: number;
  ts: string;
  kind: TraceKind;
  payload: unknown;
}

export interface TraceGap {
  afterSeq: number;
  missing: number;
  reason?: "seq" | "parse";
}

export interface ReadTraceResult {
  records: TraceRecord[];
  gaps: TraceGap[];
  recoveredPartial: boolean;
}

export class TraceAlreadyOpenError extends Error {
  constructor(public readonly path: string) {
    super(`TraceWriter already open for path: ${path}`);
    this.name = "TraceAlreadyOpenError";
  }
}
