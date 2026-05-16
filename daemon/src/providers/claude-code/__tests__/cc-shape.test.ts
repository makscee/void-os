// Minimal smoke test for cc-shape.ts. The full migration of chat/util.test.ts
// happens in VOS-96 T9, after chat/util.ts is deleted.

import { describe, expect, test } from "bun:test";
import {
  extractTurnText,
  extractToolUses,
  extractToolResults,
} from "../cc-shape";

describe("cc-shape smoke", () => {
  test("extractTurnText returns concatenated text from a one-block frame", () => {
    const rec = {
      message: { content: [{ type: "text", text: "hello" }] },
    };
    expect(extractTurnText(rec)).toBe("hello");
  });

  test("extractToolUses surfaces a single tool_use block", () => {
    const rec = {
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    };
    const uses = extractToolUses(rec);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toEqual({
      tool_call_id: "tu_1",
      name: "Bash",
      input: { command: "ls" },
    });
  });

  test("extractToolResults surfaces a single tool_result block", () => {
    const rec = {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "ok",
          },
        ],
      },
    };
    const results = extractToolResults(rec);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      tool_call_id: "tu_1",
      output: "ok",
      is_error: false,
    });
  });
});
