// util tests — VOS-80 S4 (tool-call panel daemon contract).
//
// Covers extractToolUses + extractToolResults: the shared CC-shape parsers
// that both orchestrator (live stream) and session-replay (JSONL walk) use
// to surface tool events as separate WS frames + replay entries.

import { test, expect } from "bun:test";
import {
  extractTurnText,
  extractToolUses,
  extractToolResults,
} from "../../src/chat/util";

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

// ── extractTurnText interaction (regression: tool_use/tool_result don't leak)

test("extractTurnText still ignores tool_result blocks (no text leakage)", () => {
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
