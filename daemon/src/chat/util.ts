// Shared CC-shape helpers for chat module.
//
// Both `orchestrator.ts` (live stream events) and `session-replay.ts` (JSONL
// DAG records) need the same extraction logic: text lives at
// `record.message.content[]` as an array of blocks like
// `{ type: "text", text: string }`, interleaved with `{ type: "tool_use", ... }`,
// `{ type: "tool_result", ... }`, etc. We concatenate `text` blocks only;
// tool_use / tool_result blocks are surfaced via separate event paths
// (chat.tool_call / chat.tool_result) and will be rendered by S4 UI separately.
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
