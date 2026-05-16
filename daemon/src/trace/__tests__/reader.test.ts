import { describe, test, expect, afterAll } from "bun:test";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTrace } from "../reader";

const tmpRoot = mkdtempSync(join(tmpdir(), "trace-reader-"));
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function fixture(records: object[]): string {
  return records.map(r => JSON.stringify(r)).join("\n") + "\n";
}

describe("readTrace — basic", () => {
  test("missing file → empty result, no throw", () => {
    const out = readTrace(join(tmpRoot, "does-not-exist.jsonl"));
    expect(out.records).toEqual([]);
    expect(out.gaps).toEqual([]);
    expect(out.recoveredPartial).toBe(false);
  });

  test("clean 5-record file → 5 records, no gaps, recoveredPartial=false", () => {
    const path = join(tmpRoot, "clean.jsonl");
    const records = [0,1,2,3,4].map(i => ({ seq: i, ts: "2026-05-16T00:00:00.000Z", kind: "cc.event", payload: { i } }));
    writeFileSync(path, fixture(records));

    const out = readTrace(path);
    expect(out.records.length).toBe(5);
    expect(out.records.map(r => r.seq)).toEqual([0,1,2,3,4]);
    expect(out.gaps).toEqual([]);
    expect(out.recoveredPartial).toBe(false);
  });
});

describe("readTrace — partial trailing", () => {
  test("trailing partial line is dropped, recoveredPartial=true, file unchanged", () => {
    const path = join(tmpRoot, "partial.jsonl");
    const records = [0,1,2,3,4].map(i => ({ seq: i, ts: "2026-05-16T00:00:00.000Z", kind: "cc.event", payload: { i } }));
    const text = fixture(records) + '{"seq":5,"ts":"2026-05-16","kind"';
    writeFileSync(path, text);

    const before = readFileSync(path, "utf8");
    const out = readTrace(path);
    const after = readFileSync(path, "utf8");

    expect(out.records.length).toBe(5);
    expect(out.recoveredPartial).toBe(true);
    expect(after).toBe(before);
  });

  test("file ending in \\n with no trailing bytes → recoveredPartial=false", () => {
    const path = join(tmpRoot, "no-partial.jsonl");
    writeFileSync(path, fixture([{ seq: 0, ts: "x", kind: "cc.event", payload: {} }]));
    const out = readTrace(path);
    expect(out.recoveredPartial).toBe(false);
    expect(out.records.length).toBe(1);
  });
});

describe("readTrace — gap detection", () => {
  test("seqs [0,1,2,5,6] produces one seq gap {afterSeq:2, missing:2}", () => {
    const path = join(tmpRoot, "gap.jsonl");
    const records = [0,1,2,5,6].map(i => ({ seq: i, ts: "x", kind: "cc.event", payload: { i } }));
    writeFileSync(path, fixture(records));
    const out = readTrace(path);
    expect(out.records.length).toBe(5);
    expect(out.gaps).toEqual([{ afterSeq: 2, missing: 2, reason: "seq" }]);
  });

  test("seqs [0,3,4,9] produces two seq gaps", () => {
    const path = join(tmpRoot, "gaps2.jsonl");
    const records = [0,3,4,9].map(i => ({ seq: i, ts: "x", kind: "cc.event", payload: { i } }));
    writeFileSync(path, fixture(records));
    const out = readTrace(path);
    expect(out.gaps).toEqual([
      { afterSeq: 0, missing: 2, reason: "seq" },
      { afterSeq: 4, missing: 4, reason: "seq" },
    ]);
  });
});

describe("readTrace — soft corruption handling", () => {
  test("mid-file garbage line is skipped and recorded as parse gap", () => {
    const path = join(tmpRoot, "corrupt.jsonl");
    const before = [0,1,2].map(i => ({ seq: i, ts: "x", kind: "cc.event", payload: { i } }));
    const after = [3,4].map(i => ({ seq: i, ts: "x", kind: "cc.event", payload: { i } }));
    writeFileSync(path, fixture(before) + "garbage line\n" + fixture(after));
    const out = readTrace(path);
    expect(out.records.length).toBe(5);
    expect(out.gaps).toEqual([{ afterSeq: 2, missing: 1, reason: "parse" }]);
  });

  test("bad envelope (seq is a string) is treated as parse gap; no double-count seq gap", () => {
    const path = join(tmpRoot, "badenv.jsonl");
    const lines = [
      JSON.stringify({ seq: 0, ts: "x", kind: "cc.event", payload: {} }),
      JSON.stringify({ seq: "1", ts: "x", kind: "cc.event", payload: {} }),
      JSON.stringify({ seq: 2, ts: "x", kind: "cc.event", payload: {} }),
    ].join("\n") + "\n";
    writeFileSync(path, lines);
    const out = readTrace(path);
    expect(out.records.map(r => r.seq)).toEqual([0, 2]);
    // Single gap entry: parse-gap captures the bad envelope; the seq jump 0→2
    // is fully explained by it, so no separate "seq" gap is synthesized.
    expect(out.gaps).toEqual([
      { afterSeq: 0, missing: 1, reason: "parse" },
    ]);
  });

  test("seq gap larger than parse-gap count leaves a residual seq gap", () => {
    const path = join(tmpRoot, "residual.jsonl");
    const lines = [
      JSON.stringify({ seq: 0, ts: "x", kind: "cc.event", payload: {} }),
      JSON.stringify({ seq: "1", ts: "x", kind: "cc.event", payload: {} }), // bad envelope
      JSON.stringify({ seq: 5, ts: "x", kind: "cc.event", payload: {} }),    // seq jump 0→5
    ].join("\n") + "\n";
    writeFileSync(path, lines);
    const out = readTrace(path);
    expect(out.records.map(r => r.seq)).toEqual([0, 5]);
    // parse-gap of 1 + residual seq gap of 3 (since 5-0-1=4 missing, minus 1 parse = 3 residual).
    expect(out.gaps).toEqual([
      { afterSeq: 0, missing: 1, reason: "parse" },
      { afterSeq: 0, missing: 3, reason: "seq" },
    ]);
  });

  test("two consecutive garbage lines coalesce into one parse gap with missing=2", () => {
    const path = join(tmpRoot, "coalesce.jsonl");
    writeFileSync(path,
      fixture([{ seq: 0, ts: "x", kind: "cc.event", payload: {} }, { seq: 1, ts: "x", kind: "cc.event", payload: {} }]) +
      "garbage1\ngarbage2\n" +
      fixture([{ seq: 2, ts: "x", kind: "cc.event", payload: {} }])
    );
    const out = readTrace(path);
    expect(out.records.map(r => r.seq)).toEqual([0, 1, 2]);
    expect(out.gaps).toEqual([{ afterSeq: 1, missing: 2, reason: "parse" }]);
  });

  test("reader never throws on bad lines", () => {
    const path = join(tmpRoot, "allbad.jsonl");
    writeFileSync(path, "garbage1\ngarbage2\ngarbage3\n");
    expect(() => readTrace(path)).not.toThrow();
    const out = readTrace(path);
    expect(out.records).toEqual([]);
    expect(out.gaps).toEqual([{ afterSeq: -1, missing: 3, reason: "parse" }]);
  });
});
