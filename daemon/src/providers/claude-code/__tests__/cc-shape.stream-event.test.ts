// VOS-140: cc-shape normalizer tests for CC's `--include-partial-messages`
// streaming path. With that flag CC emits `stream_event` JSON lines wrapping
// Anthropic message-stream events (content_block_delta carries delta.text)
// alongside the existing `assistant` terminal frame.
//
// normalizeCcEvent (stateless):
//   - stream_event/content_block_delta/text_delta → PartsEvent (ROLE_AGENT, single TextPart)
//   - all other stream_event subtypes → null
//
// makeCcNormalizer (stateful per stream):
//   - after observing any stream_event text_delta in the current iteration,
//     subsequent `assistant` frames have their text blocks dropped (tool_use
//     blocks pass through); this prevents the terminal assistant frame from
//     double-emitting text that already streamed via deltas.
//   - when no stream_event was observed (legacy / pre-VOS-140 fakes), the
//     assistant frame passes through unchanged.

import { test, expect } from "bun:test";
import type { LegacyProviderEvent } from "../../types.ts";
import { normalizeCcEvent, makeCcNormalizer } from "../cc-shape";

// ── normalizeCcEvent stream_event branch ────────────────────────────────

test("stream_event content_block_delta text_delta → ROLE_AGENT parts with single TextPart", () => {
  const raw: LegacyProviderEvent = {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Ready." },
    },
    ts: 12345,
  };
  const out = normalizeCcEvent(raw);
  expect(out).toEqual({
    type: "parts",
    role: "ROLE_AGENT",
    parts: [{ text: "Ready." } as never],
    ts: 12345,
  });
});

test("stream_event with empty delta.text returns null", () => {
  const raw: LegacyProviderEvent = {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "" },
    },
  };
  expect(normalizeCcEvent(raw)).toBeNull();
});

test("stream_event message_start subtype returns null", () => {
  expect(
    normalizeCcEvent({
      type: "stream_event",
      event: { type: "message_start", message: {} },
    } as LegacyProviderEvent),
  ).toBeNull();
});

test("stream_event content_block_start returns null", () => {
  expect(
    normalizeCcEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    } as LegacyProviderEvent),
  ).toBeNull();
});

test("stream_event content_block_delta with input_json_delta (not text_delta) returns null", () => {
  expect(
    normalizeCcEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"a\":1}" },
      },
    } as LegacyProviderEvent),
  ).toBeNull();
});

test("stream_event message_delta / message_stop / content_block_stop all return null", () => {
  for (const t of ["message_delta", "message_stop", "content_block_stop"] as const) {
    expect(
      normalizeCcEvent({
        type: "stream_event",
        event: { type: t },
      } as LegacyProviderEvent),
    ).toBeNull();
  }
});

test("stream_event with missing inner event returns null (defensive)", () => {
  expect(
    normalizeCcEvent({ type: "stream_event" } as LegacyProviderEvent),
  ).toBeNull();
});

// ── makeCcNormalizer stateful dedup ─────────────────────────────────────

test("stateful: assistant text passes through when no stream_event observed (legacy path)", () => {
  const n = makeCcNormalizer();
  const out = n({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    },
  } as LegacyProviderEvent);
  expect(out?.type).toBe("parts");
  const parts = (out as { parts: Array<{ text?: string }> }).parts;
  expect(parts.map((p) => p.text)).toEqual(["hi"]);
});

test("stateful: assistant text is dedupped after stream_event text_delta observed", () => {
  const n = makeCcNormalizer();
  // 1) stream_event delta → emits parts with text="Hel"
  const delta = n({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  } as LegacyProviderEvent);
  expect(delta?.type).toBe("parts");
  // 2) terminal assistant frame with the COMPLETE content (text-only) → null
  const terminal = n({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  } as LegacyProviderEvent);
  expect(terminal).toBeNull();
});

test("stateful: assistant frame with text + tool_use → only tool_use survives dedup", () => {
  const n = makeCcNormalizer();
  // arm dedup
  n({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
  } as LegacyProviderEvent);
  const terminal = n({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "calling tool" },
        { type: "tool_use", id: "u_1", name: "vault.read", input: { path: "x" } },
      ],
    },
  } as LegacyProviderEvent);
  expect(terminal?.type).toBe("parts");
  const parts = (terminal as { parts: Array<{ text?: string; data?: { kind?: string } }> }).parts;
  expect(parts).toHaveLength(1);
  expect(parts[0]!.data?.kind).toBe("tool_use");
});

test("stateful: user-role text is never dedupped (CC only streams assistant text)", () => {
  const n = makeCcNormalizer();
  n({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
  } as LegacyProviderEvent);
  const userEvt = n({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "user said hi" }],
    },
  } as LegacyProviderEvent);
  expect(userEvt?.type).toBe("parts");
  const parts = (userEvt as { parts: Array<{ text?: string }> }).parts;
  expect(parts[0]!.text).toBe("user said hi");
});

test("stateful: session event is unaffected by dedup state", () => {
  const n = makeCcNormalizer();
  const sess = n({ type: "system", session_id: "sid-1" } as LegacyProviderEvent);
  expect(sess).toEqual({ type: "session", sessionId: "sid-1" });
});
