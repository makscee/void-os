#!/usr/bin/env bun
// VOS-162 Source A: PostToolUse hook script. Spawned by CC after each tool
// call completes. Unlike pre-tool-use.ts this hook does NOT gate — the
// permission decision already happened in PreToolUse. Its sole job is to
// push a `tool_return` event into the daemon's union event view so the
// inspector trace shows tool completion alongside Source-B runtime frames.
//
// Output shape (PostToolUse): {continue: true}. PostToolUse cannot block a
// tool that already ran; `continue:false` would only terminate the rest of
// the session, which is wrong for a pure observability hook. Always exit 0.
//
// Best-effort: postHookEvent is timeout-capped and never throws, so a
// slow/dead daemon costs at most POST_TIMEOUT_MS and never wedges CC.

import { postHookEvent } from "./hook-event-post";

interface ToolResult {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // CC names the post-call payload `tool_response`; tolerate either.
  tool_response?: unknown;
  tool_result?: unknown;
}

async function readStdin(): Promise<string> {
  let data = "";
  // Bun's ReadableStream is async-iterable at runtime; @types/bun types
  // stdin.stream() as a plain web ReadableStream without the iterator (VOS-167).
  const stream = Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    data += new TextDecoder().decode(chunk);
  }
  return data;
}

const raw = await readStdin();
let payload: ToolResult = {};
try {
  payload = JSON.parse(raw) as ToolResult;
} catch {
  // Malformed input — still exit cleanly; the worst case is one missed
  // observability event, never a wedged session.
}

const tool = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
const result = payload.tool_response ?? payload.tool_result;
let outcome = "ok";
if (result && typeof result === "object") {
  const isError = (result as { is_error?: unknown }).is_error;
  if (isError === true) outcome = "error";
}

await postHookEvent({
  kind: "tool_return",
  tool,
  summary: `PostToolUse ${tool} → ${outcome}`,
});

process.stdout.write(JSON.stringify({ continue: true }));
process.exit(0);
