import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript } from "../src/transcript.ts";

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
