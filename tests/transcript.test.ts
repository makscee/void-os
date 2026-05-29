import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateTranscript, parseTranscript } from "../src/transcript.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "transcript-sample.jsonl"), "utf8");

test("parseTranscript keeps only user/assistant turns with non-empty text", () => {
  const turns = parseTranscript(fixture);
  expect(turns).toEqual([
    { role: "user", text: "/smoke-test hello" },
    { role: "assistant", text: "Turn 1 done. body.html written." },
  ]);
});

test("parseTranscript joins multiple text blocks", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "text", text: "alpha " },
      { type: "tool_use", name: "X" },
      { type: "text", text: "beta" },
    ] },
  });
  expect(parseTranscript(line)).toEqual([{ role: "assistant", text: "alpha beta" }]);
});

test("parseTranscript returns [] for empty input", () => {
  expect(parseTranscript("")).toEqual([]);
});

test("locateTranscript finds <uuid>.jsonl in any project subdir", () => {
  const root = "/tmp/voidos-tx-locate";
  rmSync(root, { recursive: true, force: true });
  const uuid = "f7f5f7a4-e74e-4002-8283-9afa30dae25a";
  const sub = join(root, "-Users-admin-void-os");
  mkdirSync(sub, { recursive: true });
  const file = join(sub, `${uuid}.jsonl`);
  writeFileSync(file, "{}");
  expect(locateTranscript(uuid, root)).toBe(file);
});

test("locateTranscript returns null for unknown uuid", () => {
  const root = "/tmp/voidos-tx-locate";
  expect(locateTranscript("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", root)).toBeNull();
});

test("locateTranscript rejects a uuid failing the format guard (no fs/exec)", () => {
  expect(locateTranscript("../../etc/passwd", "/tmp/voidos-tx-locate")).toBeNull();
});

test("locateTranscript returns null when projects dir is missing", () => {
  expect(locateTranscript("f7f5f7a4-e74e-4002-8283-9afa30dae25a", "/tmp/does-not-exist-xyz")).toBeNull();
});
