import { describe, test, expect, afterAll } from "bun:test";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
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
