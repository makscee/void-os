// daemon/src/trace/writer.ts
// Use `require` (not `import * as fs`) so test spies that patch
// `require("node:fs").fdatasyncSync` patch the same binding the
// implementation calls. Bun's ESM namespace is sealed; CommonJS
// require returns a mutable object shared across require() callers.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs") as typeof import("node:fs");
import type { TraceKind } from "./types";
import { TraceAlreadyOpenError } from "./types";

const openWriters = new Map<string, TraceWriter>();

export interface TraceWriterOptions {
  /** Whether to fdatasync after every record. Default true (production durability). Tests that aren't asserting fsync semantics should pass `false` to keep the suite fast. */
  fsync?: boolean;
}

export class TraceWriter {
  private fd: number | null;
  private _seq: number;
  private readonly path: string;
  private readonly fsync: boolean;

  private constructor(path: string, fd: number, initialSeq: number, fsync: boolean) {
    this.path = path;
    this.fd = fd;
    this._seq = initialSeq;
    this.fsync = fsync;
  }

  static open(path: string, opts?: TraceWriterOptions): TraceWriter {
    if (openWriters.has(path)) {
      throw new TraceAlreadyOpenError(path);
    }
    const fd = fs.openSync(path, "a");
    const initialSeq = TraceWriter.computeInitialSeq(path);
    const fsync = opts?.fsync ?? true;
    const w = new TraceWriter(path, fd, initialSeq, fsync);
    openWriters.set(path, w);
    return w;
  }

  private static computeInitialSeq(path: string): number {
    let size = 0;
    try {
      size = fs.statSync(path).size;
    } catch {
      return 0; // missing file
    }
    if (size === 0) return 0;
    const buf = fs.readFileSync(path);
    // Find last '\n'. If none, the file has no complete line → start at 0.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return 0;
    // The last full line is bytes up to lastNl (exclusive). Find the start of
    // that line (the prior newline, or 0).
    const priorNl = buf.lastIndexOf(0x0a, lastNl - 1);
    const lineStart = priorNl < 0 ? 0 : priorNl + 1;
    const lineBytes = buf.subarray(lineStart, lastNl);
    if (lineBytes.length === 0) return 0;
    try {
      const rec = JSON.parse(lineBytes.toString("utf8"));
      if (Number.isInteger(rec.seq) && rec.seq >= 0) return rec.seq + 1;
      return 0;
    } catch {
      return 0;
    }
  }

  get seq(): number {
    return this._seq;
  }

  write(kind: TraceKind, payload: unknown): number {
    if (this.fd === null) throw new Error("TraceWriter: write after close");
    const seq = this._seq;
    const line = JSON.stringify({ seq, ts: new Date().toISOString(), kind, payload }) + "\n";
    fs.writeSync(this.fd, line);
    if (this.fsync) fs.fdatasyncSync(this.fd);
    this._seq = seq + 1;
    return seq;
  }

  close(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch { /* swallow — fd may already be closed */ }
    this.fd = null;
    openWriters.delete(this.path);
  }
}
