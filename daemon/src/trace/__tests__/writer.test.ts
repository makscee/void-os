// daemon/src/trace/__tests__/writer.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter } from "../writer";

const tmpRoot = mkdtempSync(join(tmpdir(), "trace-writer-"));
afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("TraceWriter — basic", () => {
  test("open → write one record → close produces a single JSON line with seq 0", () => {
    const path = join(tmpRoot, "basic.jsonl");
    const w = TraceWriter.open(path);
    const returnedSeq = w.write("turn.start", { runId: "r1" });
    w.close();

    expect(returnedSeq).toBe(0);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.seq).toBe(0);
    expect(rec.kind).toBe("turn.start");
    expect(rec.payload).toEqual({ runId: "r1" });
    expect(typeof rec.ts).toBe("string");
  });
});
