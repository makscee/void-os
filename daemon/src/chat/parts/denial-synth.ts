// Denial synthesiser — recognises SCOPE_DENIED tool_result errors emitted
// either by the MCP boundary (vault.create rejecting cross-scope write) or
// the CC pre-tool-use hook (`{continue:false, stopReason:"WRITE_SCOPE_DENIED:…"}`)
// and converts them into a `DataPart{data:{kind:"denial",…}}` for the chat turn.
//
// Encoding rationale (VOS-109 T0 recon §A):
//   A2A v1.0 uses member-name discrimination. Tool results ride as
//   DataPart{data:{kind:"tool_result", tool_call_id, output, is_error}}; mirror
//   that shape for the denial so it round-trips through messages-repo and JSON
//   persistence without any Part union extension.

import type { DataPart, Part } from "../../types/a2a";

export type DenialData = {
  kind: "denial";
  toolCallId: string;
  reason: "scope_violation";
  attemptedPath: string;
  agent: string;
  message: string;
};

const DENY_RE = /^(WRITE_SCOPE_DENIED|READ_SCOPE_DENIED|SCOPE_DENIED):\s*(.*)$/s;

/**
 * Extract the textual payload out of a `tool_result.output`. Output is normally
 * a string (cc-shape JSON-stringifies non-strings before emitting), but legacy
 * fixtures + the parser intermediate form may carry `Array<{text:string}>`.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
      out += (b as { text: string }).text;
    }
  }
  return out;
}

/**
 * Inspect a Part. If it is a `tool_result` DataPart with `is_error===true` AND
 * the text payload starts with a SCOPE_DENIED prefix, return a synthesised
 * denial DataPart. Returns null for any non-matching shape.
 *
 * `agentName` is the run's agent identity; used as fallback when the deny text
 * has no `for agent <name>` suffix (e.g. CC hook stopReason path).
 */
export function maybeSynthDenial(p: Part, agentName: string): DataPart | null {
  const data = (p as { data?: Record<string, unknown> }).data;
  if (!data) return null;
  if (data["kind"] !== "tool_result") return null;
  if (data["is_error"] !== true) return null;

  const text = extractText(data["output"]);
  const m = text.match(DENY_RE);
  if (!m) return null;

  const code = m[1]!;
  const tail = (m[2] ?? "").trim();

  const pathMatch = tail.match(/^(\S+)/);
  const attemptedPath = pathMatch?.[1] ?? "(unknown path)";

  const agentMatch = tail.match(/for agent\s+(\S+)\s*$/);
  const agent = agentMatch?.[1] ?? agentName;

  const verb = code === "READ_SCOPE_DENIED" ? "read" : "write";
  const verbCap = verb === "write" ? "Write" : "Read";

  const toolCallId =
    typeof data["tool_call_id"] === "string" ? (data["tool_call_id"] as string) : "";

  const denialData: DenialData = {
    kind: "denial",
    toolCallId,
    reason: "scope_violation",
    attemptedPath,
    agent,
    message: `${verbCap} denied: ${agent} is not allowed to ${verb} ${attemptedPath}.`,
  };

  return { data: denialData as unknown as Record<string, unknown> };
}
