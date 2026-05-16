// VOS-87 T4: Extract per-turn UsageTurn from a CC stream-json `assistant`
// event. Pure function — factored out so the spawner stays slim and the
// extraction is unit-testable in isolation.
//
// CC's stream-json `assistant` event shape (per Anthropic SDK):
//   { type: "assistant", message: { model, usage: { input_tokens, ... }, ... } }
//
// `usage` may be absent (some assistant events stream pure text without a
// usage block — e.g. interim partial events). When absent or zero on both
// input + output, returns null (no turn to record). The spawner accumulates
// non-null results into the `usageTurns` array consumed at run.end.

import type { UsageTurn } from "../../events/index.js";

interface AssistantEventLike {
  type?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export function parseUsageFromAssistantEvent(
  event: AssistantEventLike,
): UsageTurn | null {
  if (event.type !== "assistant") return null;
  const msg = event.message;
  if (!msg || typeof msg !== "object") return null;
  const usage = msg.usage;
  if (!usage) return null;
  const inputTokens  = usage.input_tokens  ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  // Skip empty-usage events (e.g. tool_use-only partials). A turn with
  // zero input AND zero output carries no cost signal and would pollute
  // the per-run aggregate downstream consumers compute.
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens:   usage.cache_read_input_tokens     ?? 0,
    model:             msg.model ?? "claude-unknown",
    provider:          "claude-code",
  };
}
