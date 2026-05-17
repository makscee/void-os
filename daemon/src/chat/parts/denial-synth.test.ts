// Tests for denial-synth — recognise SCOPE_DENIED tool_result errors and
// synthesise a DataPart{data:{kind:"denial",…}} for the chat turn.
//
// Predicate background (see VOS-109 T0 recon §A):
//   - Daemon Part union is v1.0 A2A with member-name discrimination.
//   - Tool results ride as DataPart{data:{kind:"tool_result", tool_call_id,
//     output, is_error}} per daemon/src/providers/claude-code/cc-shape.ts:128.
//   - The synthesiser hooks the parts stream and converts deny tool_results
//     into a DataPart{data:{kind:"denial",…}} that mirrors the encoding.

import { describe, expect, test } from "bun:test";
import type { DataPart, Part } from "../../types/a2a";
import { extractText, maybeSynthDenial } from "./denial-synth";

function makeToolResult(
  output: unknown,
  isError: boolean,
  toolCallId = "tu-1",
): DataPart {
  return {
    data: {
      kind: "tool_result",
      tool_call_id: toolCallId,
      output,
      is_error: isError,
    },
  };
}

describe("extractText", () => {
  test("passes string through", () => {
    expect(extractText("hello")).toBe("hello");
  });

  test("flattens array-of-{text} blocks", () => {
    const blocks = [{ text: "foo" }, { text: "bar" }, { not_text: "ignored" }];
    expect(extractText(blocks)).toBe("foobar");
  });

  test("returns '' for unknown shapes", () => {
    expect(extractText(undefined)).toBe("");
    expect(extractText(null)).toBe("");
    expect(extractText(42)).toBe("");
    expect(extractText({ wat: "no" })).toBe("");
  });
});

describe("maybeSynthDenial", () => {
  test("SCOPE_DENIED (MCP path, with 'for agent' suffix) → denial DataPart", () => {
    const p = makeToolResult(
      "SCOPE_DENIED: journal/forbidden.md not in write_scope for agent maya",
      true,
      "tu-mcp-1",
    );
    const result = maybeSynthDenial(p, "fallback-agent");
    expect(result).not.toBeNull();
    const data = result!.data as Record<string, unknown>;
    expect(data["kind"]).toBe("denial");
    expect(data["toolCallId"]).toBe("tu-mcp-1");
    expect(data["reason"]).toBe("scope_violation");
    expect(data["attemptedPath"]).toBe("journal/forbidden.md");
    expect(data["agent"]).toBe("maya");
    expect(data["message"]).toBe(
      "Write denied: maya is not allowed to write journal/forbidden.md.",
    );
  });

  test("WRITE_SCOPE_DENIED (CC hook path, no suffix) → falls back to agentName", () => {
    const p = makeToolResult(
      "WRITE_SCOPE_DENIED: journal/2026-05-17.md",
      true,
      "tu-hook-1",
    );
    const result = maybeSynthDenial(p, "maya");
    expect(result).not.toBeNull();
    const data = result!.data as Record<string, unknown>;
    expect(data["kind"]).toBe("denial");
    expect(data["agent"]).toBe("maya");
    expect(data["attemptedPath"]).toBe("journal/2026-05-17.md");
    expect(data["message"]).toBe(
      "Write denied: maya is not allowed to write journal/2026-05-17.md.",
    );
  });

  test("READ_SCOPE_DENIED → message contains 'Read denied'", () => {
    const p = makeToolResult(
      "READ_SCOPE_DENIED: secrets/keys.env",
      true,
      "tu-read-1",
    );
    const result = maybeSynthDenial(p, "maya");
    expect(result).not.toBeNull();
    const data = result!.data as Record<string, unknown>;
    expect(data["kind"]).toBe("denial");
    expect((data["message"] as string)).toContain("Read denied");
    expect(data["attemptedPath"]).toBe("secrets/keys.env");
  });

  test("array-of-text content shape flattens (legacy fixture defence)", () => {
    const p = makeToolResult(
      [{ text: "SCOPE_DENIED: " }, { text: "journal/x.md not in write_scope for agent maya" }],
      true,
    );
    const result = maybeSynthDenial(p, "fallback");
    expect(result).not.toBeNull();
    const data = result!.data as Record<string, unknown>;
    expect(data["kind"]).toBe("denial");
    expect(data["attemptedPath"]).toBe("journal/x.md");
    expect(data["agent"]).toBe("maya");
  });

  test("is_error:false → returns null", () => {
    const p = makeToolResult(
      "SCOPE_DENIED: foo.md not in write_scope for agent maya",
      false,
    );
    expect(maybeSynthDenial(p, "maya")).toBeNull();
  });

  test("non-deny tool errors (IO_ERROR) → returns null", () => {
    const p = makeToolResult("IO_ERROR: file not found", true);
    expect(maybeSynthDenial(p, "maya")).toBeNull();
  });

  test("missing path → '(unknown path)'", () => {
    const p = makeToolResult("WRITE_SCOPE_DENIED:    ", true);
    const result = maybeSynthDenial(p, "maya");
    expect(result).not.toBeNull();
    const data = result!.data as Record<string, unknown>;
    expect(data["attemptedPath"]).toBe("(unknown path)");
  });

  test("non-DataPart (TextPart) → returns null", () => {
    const p: Part = { text: "WRITE_SCOPE_DENIED: foo" };
    expect(maybeSynthDenial(p, "maya")).toBeNull();
  });

  test("data without kind tool_result → returns null", () => {
    const p: DataPart = {
      data: { kind: "tool_use", tool_call_id: "x", tool_name: "vault.create", input: {} },
    };
    expect(maybeSynthDenial(p, "maya")).toBeNull();
  });
});
