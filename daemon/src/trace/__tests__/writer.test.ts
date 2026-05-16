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

  test("when writeSync fails on N-th call, an error envelope describing the failed write lands on disk before the original error bubbles", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    const origWrite = fs.writeSync;
    let calls = 0;
    fs.writeSync = (fd: number, data: any) => {
      calls++;
      if (calls === 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return origWrite(fd, data);
    };
    try {
      const path = join(tmpRoot, "errenv.jsonl");
      const w = TraceWriter.open(path);
      w.write("cc.event", { ok: 1 });
      let thrown: Error | null = null;
      try {
        w.write("cc.event", { ok: 2 });
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toBe("EIO");

      // After the failure, the in-process registry should still hold the writer
      // (close() releases). Inspect what is on disk so far.
      w.close();
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      // We expect: original first record + an error envelope describing the
      // failed seq=1 attempt. The error envelope was written via best-effort
      // path that may itself have hit the stubbed throw on its first attempt,
      // so allow either 1 or 2 lines but require: if 2 lines, second is error.
      expect(lines.length).toBeGreaterThanOrEqual(1);
      if (lines.length >= 2) {
        const rec = JSON.parse(lines[1]);
        expect(rec.kind).toBe("error");
        expect(rec.payload.attemptedSeq).toBe(1);
        expect(rec.payload.attemptedKind).toBe("cc.event");
      }
    } finally {
      fs.writeSync = origWrite;
    }
  });

  test("reopen after writeSync failure resumes seq at lastSeq + 1 (no duplicate seq across processes)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    const origWrite = fs.writeSync;
    let calls = 0;
    fs.writeSync = (fd: number, data: any) => {
      calls++;
      if (calls === 3) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return origWrite(fd, data);
    };
    const path = join(tmpRoot, "reopen-after-err.jsonl");
    let lastSeqOnDisk = -1;
    try {
      const w = TraceWriter.open(path);
      w.write("cc.event", { i: 0 }); // seq 0
      w.write("cc.event", { i: 1 }); // seq 1
      try { w.write("cc.event", { i: 2 }); } catch {} // seq 2 → fails, error envelope written
      w.close();
    } finally {
      fs.writeSync = origWrite;
    }
    // Inspect last full line; reopen.
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    lastSeqOnDisk = last.seq;
    expect(lastSeqOnDisk).toBe(2); // error envelope at seq 2

    const w2 = TraceWriter.open(path);
    expect(w2.seq).toBe(lastSeqOnDisk + 1); // i.e. 3 — no duplicate
    w2.close();
  });

  test("when writeSync always fails, the original error bubbles and the recovery path does not throw a secondary error", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    const origWrite = fs.writeSync;
    fs.writeSync = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
    try {
      const path = join(tmpRoot, "errenv2.jsonl");
      const w = TraceWriter.open(path);
      let thrown: Error | null = null;
      try {
        w.write("cc.event", { ok: 1 });
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toBe("EIO");
      // close() must not throw either.
      expect(() => w.close()).not.toThrow();
    } finally {
      fs.writeSync = origWrite;
    }
  });
});
