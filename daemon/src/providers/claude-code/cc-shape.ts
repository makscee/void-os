import type { Part } from "../../types/a2a.ts";
import type {
  CanonicalProviderEvent,
  LegacyProviderEvent,
} from "../types.ts";

// CC wire-format parsers — sole owner of Claude Code's `stream-json` /
// JSONL on-disk shape. Two adapters consume this module, both within
// `providers/claude-code/`:
//
//   1. providers/claude-code/provider.ts — normalizes live spawn events
//      from CC's stdout into canonical `ProviderEvent`s on yield
//      (via `normalizeCcEvent`).
//   2. providers/fake/index.ts — test fake provider that exercises the
//      same CC wire-format shape without a real spawn.
//
// CC frames carry text at `record.message.content[]` as an array of blocks
// like `{ type: "text", text: string }`, interleaved with
// `{ type: "tool_use", ... }`, `{ type: "tool_result", ... }`, etc.
//
// tool_use blocks live on assistant-role records and carry { id, name, input }.
// tool_result blocks live on user-role records and carry
// { tool_use_id, content, is_error? }. We surface them on separate WS frames
// (chat.tool_use / chat.tool_result) and as synthetic replay entries so the
// S4 UI can render a tool-call panel without parsing CC shape itself.
//
// Defensive: a legacy / pre-blocks shape may put a plain string at
// `record.message.content`. We handle that too.

export interface CcRecordLike {
  message?: unknown;
  [k: string]: unknown;
}

/**
 * Extract concatenated visible text from a CC turn record / event.
 * Returns "" when the turn has no text blocks (e.g. pure tool_use turn) or
 * the shape is unrecognised.
 */
export function extractTurnText(record: CcRecordLike): string {
  const msg = record.message as { content?: unknown } | undefined;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let s = "";
  for (const b of content) {
    if (b && typeof b === "object") {
      const block = b as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        s += block.text;
      }
    }
  }
  return s;
}

/** Surface shape for a tool_use block extracted from CC content[]. */
export interface ToolUseBlock {
  tool_call_id: string;
  name: string;
  input: unknown;
}

/** Surface shape for a tool_result block extracted from CC content[]. */
export interface ToolResultBlock {
  tool_call_id: string;
  output: unknown;
  is_error: boolean;
}

function getContentArray(record: CcRecordLike): unknown[] {
  const msg = record.message as { content?: unknown } | undefined;
  if (!msg) return [];
  return Array.isArray(msg.content) ? msg.content : [];
}

/**
 * Extract all tool_use blocks from a CC assistant turn record / event.
 * A single assistant turn may contain multiple tool_use blocks; we preserve
 * order. Blocks missing required fields (id, name, input) are skipped so
 * downstream emitters never publish empty frames.
 */
export function extractToolUses(record: CcRecordLike): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const b of getContentArray(record)) {
    if (!b || typeof b !== "object") continue;
    const block = b as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || !block.id) continue;
    if (typeof block.name !== "string" || !block.name) continue;
    if (block.input === undefined) continue;
    out.push({
      tool_call_id: block.id,
      name: block.name,
      input: block.input,
    });
  }
  return out;
}

/**
 * Extract all tool_result blocks from a CC user-role turn record / event.
 * tool_result blocks live on `user` records that wrap the model's tool
 * output for the next assistant turn. We surface them as separate replay
 * entries / WS frames rather than as user messages.
 *
 * Blocks missing tool_use_id or content are skipped — empty frames waste
 * UI bandwidth and would render as blank panel rows.
 */
/**
 * Normalize a raw CC frame (legacy `{type:"system"|"assistant"|"user", ...}`)
 * into the canonical `ProviderEvent` union per ADR-0001 §Decision.
 *
 * Mapping:
 *   - `{type:"system", subtype?:"init", session_id}` → `{type:"session", sessionId}`
 *   - `{type:"assistant", message:{content:[...]}}` → `{type:"parts", role:"ROLE_AGENT", parts, ts}`
 *   - `{type:"user", message:{content:[...]}}`      → `{type:"parts", role:"ROLE_USER",  parts, ts}`
 *
 * Each content block becomes a `Part`:
 *   - `{type:"text", text}` → `TextPart {text}`
 *   - `{type:"tool_use", id, name, input}` → `DataPart {data:{kind:"tool_use", tool_call_id, tool_name, input}}`
 *   - `{type:"tool_result", tool_use_id, content, is_error?}` → `DataPart {data:{kind:"tool_result", tool_call_id, output, is_error}}`
 *
 * Returns `null` for events that have no canonical equivalent (e.g. CC
 * `{type:"result"}` terminal sentinels, parser-only frames). The caller is
 * expected to drop nulls — consumers no longer have an `else if` branch
 * for raw CC vocabulary.
 *
 * `tool_result.output` is JSON-stringified when not already a string so
 * downstream consumers (orchestrator's `chat.tool_result` emit,
 * messages-repo.walk()) see a consistent string field — mirrors the
 * pre-canonicalization behaviour in orchestrator.ts/dispatch-child.ts.
 */
export function normalizeCcEvent(
  raw: LegacyProviderEvent,
): CanonicalProviderEvent | null {
  if (raw.type === "system" && typeof raw.session_id === "string") {
    return { type: "session", sessionId: raw.session_id };
  }
  // VOS-140: CC's `--include-partial-messages` flag emits `stream_event` frames
  // that wrap Anthropic message-stream events. The only subtype we surface is
  // `content_block_delta` with a `text_delta` payload — that's the per-token
  // text increment we want to forward as a ROLE_AGENT PartsEvent so the
  // orchestrator can fire chat.token incrementally. Every other subtype
  // (message_start, content_block_start/stop, message_delta, message_stop,
  // input_json_delta, signature_delta, …) is dropped — we don't need them
  // for token-level UI streaming.
  if (raw.type === "stream_event") {
    const inner = (raw as { event?: unknown }).event as
      | {
          type?: unknown;
          delta?: { type?: unknown; text?: unknown };
        }
      | undefined;
    if (!inner || typeof inner !== "object") return null;
    if (inner.type !== "content_block_delta") return null;
    const delta = inner.delta;
    if (!delta || typeof delta !== "object") return null;
    if (delta.type !== "text_delta") return null;
    if (typeof delta.text !== "string" || delta.text.length === 0) return null;
    const ts = typeof raw.ts === "number" ? raw.ts : Date.now();
    return {
      type: "parts",
      role: "ROLE_AGENT",
      parts: [{ text: delta.text } as Part],
      ts,
    };
  }
  if (raw.type === "assistant" || raw.type === "user") {
    const role = raw.type === "assistant" ? "ROLE_AGENT" : "ROLE_USER";
    const ts = typeof raw.ts === "number" ? raw.ts : Date.now();
    const parts: Part[] = [];
    const msg = raw.message as { content?: unknown } | undefined;
    const content = msg?.content;
    if (typeof content === "string") {
      // Defensive: legacy pre-blocks shape may put a plain string here.
      if (content.length > 0) parts.push({ text: content } as Part);
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        const block = b as {
          type?: unknown;
          text?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
          tool_use_id?: unknown;
          content?: unknown;
          is_error?: unknown;
        };
        if (block.type === "text" && typeof block.text === "string") {
          parts.push({ text: block.text } as Part);
        } else if (block.type === "tool_use") {
          if (typeof block.id !== "string" || !block.id) continue;
          if (typeof block.name !== "string" || !block.name) continue;
          if (block.input === undefined) continue;
          parts.push({
            data: {
              kind: "tool_use",
              tool_call_id: block.id,
              tool_name: block.name,
              input: block.input,
            },
            metadata: { ts },
          } as unknown as Part);
        } else if (block.type === "tool_result") {
          if (typeof block.tool_use_id !== "string" || !block.tool_use_id) continue;
          if (block.content === undefined) continue;
          const rawOut = block.content;
          const output =
            typeof rawOut === "string"
              ? rawOut
              : (() => {
                  try {
                    return JSON.stringify(rawOut);
                  } catch {
                    return String(rawOut);
                  }
                })();
          parts.push({
            data: {
              kind: "tool_result",
              tool_call_id: block.tool_use_id,
              output,
              is_error: block.is_error === true,
            },
            metadata: { ts },
          } as unknown as Part);
        }
      }
    }
    if (parts.length === 0) return null;
    return { type: "parts", role, parts, ts };
  }
  // Non-canonical frames (e.g. CC `{type:"result"}`, parser-only sentinels)
  // have no consumer-facing equivalent in the canonical union — drop them.
  return null;
}

/**
 * VOS-140: stateful CC normalizer for a single provider run.
 *
 * Wraps `normalizeCcEvent` with a per-stream flag tracking whether any
 * `stream_event` content_block_delta text_delta has been observed in this
 * iteration. When yes, the terminal `assistant` frame's text blocks are
 * dropped (they would otherwise double-emit text that was already streamed
 * incrementally). tool_use blocks on the assistant frame are always kept.
 *
 * When no stream_event text_delta has been observed (e.g. legacy spawner,
 * test fakes that emit only assistant frames), the assistant text passes
 * through unchanged — preserving back-compat with every test that pre-dates
 * `--include-partial-messages`.
 *
 * Each provider spawn / iterator instantiates a fresh normalizer; the state
 * resets per run.
 */
export function makeCcNormalizer(): (
  raw: LegacyProviderEvent,
) => CanonicalProviderEvent | null {
  let sawStreamingText = false;
  return (raw: LegacyProviderEvent): CanonicalProviderEvent | null => {
    // Detect text_delta arrivals before delegating, so the assistant-frame
    // dedup below knows whether to drop terminal text blocks.
    if (raw.type === "stream_event") {
      const inner = (raw as { event?: unknown }).event as
        | { type?: unknown; delta?: { type?: unknown; text?: unknown } }
        | undefined;
      if (
        inner &&
        typeof inner === "object" &&
        inner.type === "content_block_delta" &&
        inner.delta &&
        typeof inner.delta === "object" &&
        inner.delta.type === "text_delta" &&
        typeof inner.delta.text === "string" &&
        inner.delta.text.length > 0
      ) {
        sawStreamingText = true;
      }
      return normalizeCcEvent(raw);
    }
    if (sawStreamingText && raw.type === "assistant") {
      // Strip text blocks before normalize so they don't double-emit. We
      // synthesize a shallow-cloned record with text blocks removed; tool_use
      // and other block types pass through untouched. If after filtering
      // there are no remaining content blocks, the normalizer's existing
      // `if (parts.length === 0) return null` short-circuits.
      const msg = raw.message as { content?: unknown } | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        const filtered = content.filter((b) => {
          if (!b || typeof b !== "object") return true;
          return (b as { type?: unknown }).type !== "text";
        });
        const cloned: LegacyProviderEvent = {
          ...raw,
          message: { ...(msg ?? {}), content: filtered },
        };
        return normalizeCcEvent(cloned);
      }
    }
    return normalizeCcEvent(raw);
  };
}

export function extractToolResults(record: CcRecordLike): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const b of getContentArray(record)) {
    if (!b || typeof b !== "object") continue;
    const block = b as {
      type?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
    };
    if (block.type !== "tool_result") continue;
    if (typeof block.tool_use_id !== "string" || !block.tool_use_id) continue;
    if (block.content === undefined) continue;
    out.push({
      tool_call_id: block.tool_use_id,
      output: block.content,
      is_error: block.is_error === true,
    });
  }
  return out;
}
