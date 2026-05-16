// CC wire-format parsers — sole owner of Claude Code's `stream-json` /
// JSONL on-disk shape. Two adapters consume this module:
//
//   1. providers/claude-code/provider.ts — normalizes live spawn events
//      from CC's stdout into canonical `ProviderEvent`s on yield.
//   2. chat/session-replay.ts — replays pre-VOS-80 legacy CC JSONL
//      records into A2A `Part[]`. Same on-disk shape, same parsers.
//
// Per ADR-0001 (2026-05-16), CC vocabulary does not belong under `chat/`.
// chat/util.ts is now a thin re-export shim and will be deleted in T9.
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
