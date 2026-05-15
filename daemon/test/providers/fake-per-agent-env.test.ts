import { describe, test, expect, afterEach } from "bun:test";
import { resolveFakeScript } from "../../src/providers/fake/index.ts";

afterEach(() => {
  delete process.env.VOS_FAKE_SCRIPT;
  delete process.env.VOS_FAKE_SCRIPT_maya;
  delete process.env.VOS_FAKE_SCRIPT_journaler;
});

describe("resolveFakeScript", () => {
  test("agent-specific env wins", () => {
    process.env.VOS_FAKE_SCRIPT = "/tmp/global.jsonl";
    process.env.VOS_FAKE_SCRIPT_maya = "/tmp/maya.jsonl";
    expect(resolveFakeScript("maya")).toBe("/tmp/maya.jsonl");
  });
  test("falls back to global", () => {
    process.env.VOS_FAKE_SCRIPT = "/tmp/global.jsonl";
    expect(resolveFakeScript("maya")).toBe("/tmp/global.jsonl");
  });
  test("returns undefined when neither set", () => {
    expect(resolveFakeScript("maya")).toBeUndefined();
  });
});
