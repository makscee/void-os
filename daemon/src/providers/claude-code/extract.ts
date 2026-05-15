import type { ProviderEvent } from "../types.ts";
import { extractTurnText } from "../../chat/util.ts";

/**
 * Extract concatenated text from a CC stream-json `assistant` event. Per the
 * SDK shape, assistant events carry `{ message: { content: [{type:"text",
 * text}, {type:"tool_use", ...}, ...] } }`. We only sum text blocks; tool_use
 * blocks are surfaced separately via the `tool_use` event path. Returns "" if
 * the event has no recognisable text content (e.g. a pure tool-call turn).
 */
export function extractAssistantText(evt: ProviderEvent): string {
  return extractTurnText(evt);
}
