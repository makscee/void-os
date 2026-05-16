import * as fs from "node:fs";
import type { TraceRecord, TraceGap, ReadTraceResult } from "./types";

export function readTrace(path: string): ReadTraceResult {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { records: [], gaps: [], recoveredPartial: false };
    }
    throw err;
  }

  let recoveredPartial = false;
  let end = buf.length;
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) {
    // No newline at all — whole file is partial.
    if (buf.length > 0) recoveredPartial = true;
    end = 0;
  } else {
    if (lastNl !== buf.length - 1) recoveredPartial = true;
    end = lastNl + 1; // include trailing \n
  }

  const text = buf.subarray(0, end).toString("utf8");
  const lines = text.split("\n").slice(0, -1); // drop trailing empty

  const records: TraceRecord[] = [];
  const gaps: TraceGap[] = [];
  let lastValidSeq = -1;
  let pendingParseGap = 0;

  const flushParseGap = () => {
    if (pendingParseGap > 0) {
      gaps.push({ afterSeq: lastValidSeq, missing: pendingParseGap, reason: "parse" });
      pendingParseGap = 0;
    }
  };

  for (const line of lines) {
    if (line.length === 0) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      pendingParseGap++;
      continue;
    }
    const ok =
      Number.isInteger(rec.seq) &&
      rec.seq >= 0 &&
      typeof rec.kind === "string" &&
      typeof rec.ts === "string";
    if (!ok) {
      pendingParseGap++;
      continue;
    }
    // Compute parse-gap count BEFORE flushing so we can subtract it from any
    // coincident seq gap. The parse gap already accounts for that many missing
    // records — emitting both would double-count.
    const parseCount = pendingParseGap;
    flushParseGap();
    if (records.length > 0) {
      const prev = records[records.length - 1].seq;
      const seqMissing = rec.seq - prev - 1;
      const residual = seqMissing - parseCount;
      if (residual > 0) {
        gaps.push({ afterSeq: prev, missing: residual, reason: "seq" });
      }
    }
    records.push(rec as TraceRecord);
    lastValidSeq = rec.seq;
  }
  flushParseGap();

  return { records, gaps, recoveredPartial };
}
