// daemon/src/trace/__tests__/writer-concurrency.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter } from "../writer";
import { TraceAlreadyOpenError } from "../types";

const tmpRoot = mkdtempSync(join(tmpdir(), "trace-conc-"));
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("TraceWriter — concurrency", () => {
  test("opening the same path twice throws TraceAlreadyOpenError", () => {
    const path = join(tmpRoot, "lock.jsonl");
    const w1 = TraceWriter.open(path);
    try {
      expect(() => TraceWriter.open(path)).toThrow(TraceAlreadyOpenError);
    } finally {
      w1.close();
    }
  });

  test("after close(), the same path can be opened again", () => {
    const path = join(tmpRoot, "lock2.jsonl");
    TraceWriter.open(path).close();
    const w2 = TraceWriter.open(path);
    w2.write("cc.event", { ok: true });
    w2.close();
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });

  test("parallel writers on different files have independent seq counters", () => {
    const a = join(tmpRoot, "a.jsonl");
    const b = join(tmpRoot, "b.jsonl");
    const wa = TraceWriter.open(a);
    const wb = TraceWriter.open(b);
    // Interleave 50/50.
    for (let i = 0; i < 50; i++) {
      wa.write("cc.event", { a: i });
      wb.write("cc.event", { b: i });
    }
    wa.close();
    wb.close();
    const linesA = readFileSync(a, "utf8").split("\n").filter(Boolean);
    const linesB = readFileSync(b, "utf8").split("\n").filter(Boolean);
    expect(linesA.length).toBe(50);
    expect(linesB.length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(JSON.parse(linesA[i]!)).toMatchObject({ seq: i, payload: { a: i } });
      expect(JSON.parse(linesB[i]!)).toMatchObject({ seq: i, payload: { b: i } });
    }
  });

  test("reopen on non-empty file resumes seq at lastSeq + 1", () => {
    const path = join(tmpRoot, "reopen.jsonl");
    const w1 = TraceWriter.open(path);
    w1.write("cc.event", { i: 0 });
    w1.write("cc.event", { i: 1 });
    w1.write("cc.event", { i: 2 });
    w1.close();

    const w2 = TraceWriter.open(path);
    expect(w2.seq).toBe(3);
    w2.write("cc.event", { i: 3 });
    w2.write("cc.event", { i: 4 });
    w2.close();

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(JSON.parse(lines[i]!).seq).toBe(i);
    }
  });

  test("reopen on empty file starts seq at 0", () => {
    const path = join(tmpRoot, "empty.jsonl");
    // Touch the file empty.
    TraceWriter.open(path).close();
    const w = TraceWriter.open(path);
    expect(w.seq).toBe(0);
    w.close();
  });
});
