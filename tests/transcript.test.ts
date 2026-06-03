import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateTranscript, parseTranscript, renderTranscript } from "../src/transcript.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "transcript-sample.jsonl"), "utf8");

test("parseTranscript keeps user/assistant text turns from fixture", () => {
  const turns = parseTranscript(fixture);
  // user plain-string content → kind:text
  expect(turns.some(t => t.role === "user" && t.kind === "text" && t.text === "/smoke-test hello")).toBe(true);
  // assistant text block → kind:text
  expect(turns.some(t => t.role === "assistant" && t.kind === "text" && t.text === "Turn 1 done. body.html written.")).toBe(true);
});

test("parseTranscript extracts all event kinds from fixture", () => {
  const turns = parseTranscript(fixture);
  // fixture has a tool_use Bash block, a tool_result, and a mode meta event
  expect(turns.some(t => t.kind === "tool_use")).toBe(true);
  expect(turns.some(t => t.kind === "tool_result")).toBe(true);
  expect(turns.some(t => t.kind === "meta")).toBe(true);
});

test("parseTranscript returns [] for empty input", () => {
  expect(parseTranscript("")).toEqual([]);
});

test("parseTranscript tags chat, tool, thinking, and meta kinds", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { content: "hello" } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi there" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", content: "file1\nfile2" },
    ] } }),
    JSON.stringify({ type: "system", content: "system note" }),
  ].join("\n");
  const turns = parseTranscript(jsonl);
  // user text
  expect(turns.find(t => t.role === "user" && t.kind === "text")?.text).toBe("hello");
  // assistant carries separate blocks tagged by kind
  const a = turns.filter(t => t.role === "assistant");
  expect(a.some(t => t.kind === "thinking")).toBe(true);
  expect(a.some(t => t.kind === "text" && t.text === "hi there")).toBe(true);
  expect(a.some(t => t.kind === "tool_use")).toBe(true);
  // tool_result tagged
  expect(turns.some(t => t.kind === "tool_result")).toBe(true);
  // meta tagged
  expect(turns.some(t => t.kind === "meta")).toBe(true);
});

test("parseTranscript skips whitespace-only text blocks", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "text", text: "   " },
      { type: "text", text: "beta" },
    ] },
  });
  const turns = parseTranscript(line);
  expect(turns).toHaveLength(1);
  expect(turns[0].text).toBe("beta");
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

test("renderTranscript labels roles and escapes text", () => {
  const html = renderTranscript([
    { role: "user", kind: "text", text: "/smoke <b>hi</b>" },
    { role: "assistant", kind: "text", text: "done & ok" },
  ]);
  expect(html).toContain('class="turn role-user kind-text"');
  expect(html).toContain("you:");
  expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
  expect(html).toContain('class="turn role-assistant kind-text"');
  expect(html).toContain("claude:");
  expect(html).toContain("done &amp; ok");
  expect(html).not.toContain("<b>hi</b>");
});

test("renderTranscript emits data-kind and data-role attributes", () => {
  const html = renderTranscript([
    { role: "user", kind: "text", text: "hello" },
    { role: "assistant", kind: "tool_use", text: "Bash {}" },
    { role: "assistant", kind: "thinking", text: "hmm" },
    { role: "system", kind: "meta", text: "[mode] default" },
  ]);
  expect(html).toContain('data-kind="text"');
  expect(html).toContain('data-kind="tool_use"');
  expect(html).toContain('data-kind="thinking"');
  expect(html).toContain('data-kind="meta"');
  expect(html).toContain('data-role="user"');
  expect(html).toContain('data-role="assistant"');
  expect(html).toContain('data-role="system"');
});

test("renderTranscript returns empty string for no turns", () => {
  expect(renderTranscript([])).toBe("");
});
