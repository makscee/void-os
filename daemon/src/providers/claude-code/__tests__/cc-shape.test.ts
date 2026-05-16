// CC-shape parser tests — VOS-96 T9.
//
// Migrated from:
//   - daemon/test/chat/util.test.ts (deleted in T9)
//   - daemon/test/chat/orchestrator.test.ts (extractAssistantText cases — the
//     deprecated extract.ts shim simply delegated to extractTurnText, so the
//     assertions are reproduced verbatim against extractTurnText here)
//
// Covers the three exported CC-shape parsers that both the orchestrator
// (live stream) and session-replay (JSONL walk) use to surface tool events
// as separate WS frames + replay entries.

import { test, expect } from "bun:test";
import {
  extractTurnText,
  extractToolUses,
  extractToolResults,
} from "../cc-shape";

// ── extractTurnText (was extractAssistantText via shim) ────────────────

test("extractTurnText: single text block", () => {
  expect(
    extractTurnText({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    }),
  ).toBe("hello");
});

test("extractTurnText: multiple text blocks concatenate", () => {
  expect(
    extractTurnText({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "foo " },
          { type: "text", text: "bar" },
        ],
      },
    }),
  ).toBe("foo bar");
});

test("extractTurnText: mixed text + tool_use blocks return only text", () => {
  expect(
    extractTurnText({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "thinking: " },
          { type: "tool_use", id: "u_1", name: "vault.read", input: {} },
          { type: "text", text: "done" },
        ],
      },
    }),
  ).toBe("thinking: done");
});

test("extractTurnText: missing message returns empty string", () => {
  expect(extractTurnText({ type: "assistant" } as never)).toBe("");
});

test("extractTurnText: empty content array returns empty string", () => {
  expect(
    extractTurnText({
      type: "assistant",
      message: { role: "assistant", content: [] },
    }),
  ).toBe("");
});

test("extractTurnText: tool-use-only content returns empty string", () => {
  expect(
    extractTurnText({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "u_1", name: "x", input: {} }],
      },
    }),
  ).toBe("");
});

test("extractTurnText: ignores tool_result blocks (no text leakage)", () => {
  expect(
    extractTurnText({
      message: {
        content: [
          { type: "tool_result", tool_use_id: "u_1", content: "noise" },
        ],
      },
    }),
  ).toBe("");
});

// ── extractToolUses ────────────────────────────────────────────────────

test("extractToolUses: single tool_use block returns one entry with id/name/input", () => {
  expect(
    extractToolUses({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "u_1", name: "vault.read", input: { path: "x" } },
        ],
      },
    }),
  ).toEqual([
    { tool_call_id: "u_1", name: "vault.read", input: { path: "x" } },
  ]);
});

test("extractToolUses: multiple tool_use blocks preserve order", () => {
  const result = extractToolUses({
    message: {
      content: [
        { type: "tool_use", id: "u_1", name: "a", input: {} },
        { type: "text", text: "between" },
        { type: "tool_use", id: "u_2", name: "b", input: { k: 1 } },
      ],
    },
  });
  expect(result.map((t) => t.tool_call_id)).toEqual(["u_1", "u_2"]);
  expect(result.map((t) => t.name)).toEqual(["a", "b"]);
});

test("extractToolUses: text-only content returns []", () => {
  expect(
    extractToolUses({
      message: { content: [{ type: "text", text: "hi" }] },
    }),
  ).toEqual([]);
});

test("extractToolUses: missing message returns []", () => {
  expect(extractToolUses({})).toEqual([]);
});

test("extractToolUses: tool_use missing id is skipped (no empty frames)", () => {
  expect(
    extractToolUses({
      message: {
        content: [{ type: "tool_use", name: "x", input: {} }],
      },
    }),
  ).toEqual([]);
});

test("extractToolUses: tool_use missing name is skipped", () => {
  expect(
    extractToolUses({
      message: {
        content: [{ type: "tool_use", id: "u_1", input: {} }],
      },
    }),
  ).toEqual([]);
});

test("extractToolUses: tool_use missing input is skipped", () => {
  expect(
    extractToolUses({
      message: {
        content: [{ type: "tool_use", id: "u_1", name: "x" }],
      },
    }),
  ).toEqual([]);
});

test("extractToolUses: empty input object is OK (not skipped)", () => {
  expect(
    extractToolUses({
      message: {
        content: [{ type: "tool_use", id: "u_1", name: "x", input: {} }],
      },
    }),
  ).toEqual([{ tool_call_id: "u_1", name: "x", input: {} }]);
});

// ── extractToolResults ─────────────────────────────────────────────────

test("extractToolResults: single tool_result block returns one entry", () => {
  expect(
    extractToolResults({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "u_1", content: "file1\n" },
        ],
      },
    }),
  ).toEqual([
    { tool_call_id: "u_1", output: "file1\n", is_error: false },
  ]);
});

test("extractToolResults: is_error true is surfaced", () => {
  expect(
    extractToolResults({
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "u_1",
            content: "boom",
            is_error: true,
          },
        ],
      },
    }),
  ).toEqual([{ tool_call_id: "u_1", output: "boom", is_error: true }]);
});

test("extractToolResults: structured content (array) is passed through verbatim", () => {
  const out = extractToolResults({
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "u_1",
          content: [{ type: "text", text: "ok" }],
        },
      ],
    },
  });
  expect(out.length).toBe(1);
  expect(out[0]!.output).toEqual([{ type: "text", text: "ok" }]);
});

test("extractToolResults: multiple results preserve order", () => {
  const out = extractToolResults({
    message: {
      content: [
        { type: "tool_result", tool_use_id: "u_1", content: "a" },
        { type: "tool_result", tool_use_id: "u_2", content: "b" },
      ],
    },
  });
  expect(out.map((r) => r.tool_call_id)).toEqual(["u_1", "u_2"]);
});

test("extractToolResults: missing tool_use_id is skipped", () => {
  expect(
    extractToolResults({
      message: { content: [{ type: "tool_result", content: "x" }] },
    }),
  ).toEqual([]);
});

test("extractToolResults: missing content is skipped (no empty frames)", () => {
  expect(
    extractToolResults({
      message: { content: [{ type: "tool_result", tool_use_id: "u_1" }] },
    }),
  ).toEqual([]);
});

test("extractToolResults: text-only content returns []", () => {
  expect(
    extractToolResults({
      message: { content: [{ type: "text", text: "hi" }] },
    }),
  ).toEqual([]);
});
