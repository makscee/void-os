// daemon/src/trace/__tests__/writer.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter } from "../writer";

const tmpRoot = mkdtempSync(join(tmpdir(), "trace-writer-"));
afterAll(() => {
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

  test("100 records: monotonic seq 0..99, ts non-decreasing, payloads round-trip", () => {
    const path = join(tmpRoot, "many.jsonl");
    const w = TraceWriter.open(path);
    for (let i = 0; i < 100; i++) {
      w.write("cc.event", { i });
    }
    w.close();

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(100);
    let prevTs = "";
    for (let i = 0; i < 100; i++) {
      const r = JSON.parse(lines[i]);
      expect(r.seq).toBe(i);
      expect(r.kind).toBe("cc.event");
      expect(r.payload).toEqual({ i });
      expect(r.ts >= prevTs).toBe(true);
      prevTs = r.ts;
    }
  });

  test("fdatasyncSync called once per record", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    const orig = fs.fdatasyncSync;
    let calls = 0;
    fs.fdatasyncSync = (fd: number) => { calls++; return orig(fd); };
    try {
      const path = join(tmpRoot, "fsync.jsonl");
      const w = TraceWriter.open(path);
      for (let i = 0; i < 7; i++) w.write("cc.event", { i });
      w.close();
      expect(calls).toBe(7);
    } finally {
      fs.fdatasyncSync = orig;
    }
  });
});
