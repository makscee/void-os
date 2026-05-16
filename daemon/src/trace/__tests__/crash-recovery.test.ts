import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, truncateSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter } from "../writer";
import { readTrace } from "../reader";

const tmpRoot = mkdtempSync(join(tmpdir(), "trace-crash-"));
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("crash recovery — writer + reader integration", () => {
  test("write 10 records, truncate mid-line at seq 7, read recovers seqs 0..6", () => {
    const path = join(tmpRoot, "crash.jsonl");
    const w = TraceWriter.open(path);
    for (let i = 0; i < 10; i++) w.write("cc.event", { i });
    w.close();

    // Find the byte offset where seq=7's line starts, then truncate 5 bytes in.
    const buf = readFileSync(path);
    let nlSeen = 0;
    let seq7Start = -1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        nlSeen++;
        if (nlSeen === 7) {
          seq7Start = i + 1;
          break;
        }
      }
    }
    expect(seq7Start).toBeGreaterThan(0);
    truncateSync(path, seq7Start + 5);

    const out = readTrace(path);
    expect(out.records.map(r => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out.recoveredPartial).toBe(true);
    expect(out.gaps).toEqual([]); // no gaps inside the kept records
  });

  test("truncating 3 bytes off the end (mid-last-line, not at boundary) recovers all but the last record", () => {
    const path = join(tmpRoot, "midcut.jsonl");
    const w = TraceWriter.open(path);
    for (let i = 0; i < 5; i++) w.write("cc.event", { i });
    w.close();

    const sizeBefore = readFileSync(path).length;
    // Cut 3 bytes off the final \n+last record contents to land mid-line.
    truncateSync(path, sizeBefore - 3);

    const out = readTrace(path);
    expect(out.records.map(r => r.seq)).toEqual([0, 1, 2, 3]);
    expect(out.recoveredPartial).toBe(true);
    expect(out.gaps).toEqual([]);
  });
});
