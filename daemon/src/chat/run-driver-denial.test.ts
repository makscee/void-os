// VOS-109 T3: run-driver wires the denial synthesiser. After every parts
// frame, any DataPart{data:{kind:"tool_result", is_error:true}} carrying a
// SCOPE_DENIED prefix must yield a synthesised denial DataPart appended
// inline (both into the accumulated agentParts AND the onPart callback's
// frame parts).
//
// Predicate spec lives in daemon/src/chat/parts/denial-synth.ts (T1/T2).

import { describe, expect, test } from "bun:test";
import type { DataPart, Part, Role } from "../types/a2a";
import type { ProviderHandle } from "../providers/types";
import { drainRun, type PartFrame } from "./run-driver";

// Build a stub ProviderHandle whose events generator yields one parts frame
// then exits with done={reason:"exit"}.
function makeHandle(frame: { role: Role; parts: Part[] }): ProviderHandle {
  let cancelled = false;
  const events = (async function* () {
    yield { type: "parts", role: frame.role, parts: frame.parts } as unknown as {
      type: "parts";
      role: Role;
      parts: Part[];
    };
  })();
  return {
    events: events as unknown as AsyncIterable<unknown>,
    done: Promise.resolve({ reason: "exit", exitCode: 0 }),
    cancel: async () => {
      cancelled = true;
      return cancelled;
    },
  } as unknown as ProviderHandle;
}

function makeToolResultPart(
  output: string,
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

describe("drainRun + denial-synth wiring", () => {
  test("frame [text, deny-tool_result] → agentParts includes synthesised denial; onPart sees augmented frame", async () => {
    const text: Part = { text: "creating it" } as Part;
    const denyResult = makeToolResultPart(
      "SCOPE_DENIED: journal/forbidden.md not in write_scope for agent maya",
      true,
      "tu-mcp-1",
    );

    const handle = makeHandle({
      role: "ROLE_AGENT",
      parts: [text, denyResult],
    });

    const frames: PartFrame[] = [];
    const outcome = await drainRun({
      handle,
      agentName: "maya",
      onPart: (f) => frames.push(f),
    });

    // agentParts: text, deny tool_result, synthesised denial = 3 entries.
    // mergeAdjacentText leaves non-text untouched; text is single → no merge.
    expect(outcome.parts.length).toBe(3);
    const synth = outcome.parts[2] as DataPart;
    const sdata = synth.data as Record<string, unknown>;
    expect(sdata["kind"]).toBe("denial");
    expect(sdata["toolCallId"]).toBe("tu-mcp-1");
    expect(sdata["agent"]).toBe("maya");
    expect((sdata["message"] as string)).toMatch(/denied/i);
    expect(sdata["attemptedPath"]).toBe("journal/forbidden.md");

    // onPart frame received augmented parts list (same 3).
    expect(frames.length).toBe(1);
    expect(frames[0]!.parts.length).toBe(3);
    const frameSynth = frames[0]!.parts[2] as DataPart;
    expect((frameSynth.data as Record<string, unknown>)["kind"]).toBe("denial");
    expect(frames[0]!.role).toBe("ROLE_AGENT");
    expect(frames[0]!.frameText).toBe("creating it");
  });

  test("non-deny tool error (IO_ERROR) → no denial appended; agentParts length unchanged", async () => {
    const text: Part = { text: "trying" } as Part;
    const ioErr = makeToolResultPart("IO_ERROR: file not found", true, "tu-io-1");

    const handle = makeHandle({
      role: "ROLE_AGENT",
      parts: [text, ioErr],
    });

    const frames: PartFrame[] = [];
    const outcome = await drainRun({
      handle,
      agentName: "maya",
      onPart: (f) => frames.push(f),
    });

    // 2 in, 2 out (no synth).
    expect(outcome.parts.length).toBe(2);
    expect(frames[0]!.parts.length).toBe(2);
    // None of the parts has kind:"denial".
    for (const p of outcome.parts) {
      const d = (p as DataPart).data;
      if (d) expect((d as Record<string, unknown>)["kind"]).not.toBe("denial");
    }
  });
});
