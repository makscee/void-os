// VOS-106 T10.B: agent-persona body extraction for `--append-system-prompt`.
//
// The model needs to see the agent.md body (routing rules, voice, hard
// constraints like "must emit ask_agent(...)"). Frontmatter is already
// parsed into agent_cards by scanVaultAgents; here we re-read the file
// at spawn time and extract just the markdown body so CC can append it
// to its default system prompt via the `--append-system-prompt` flag.
//
// Reading on-demand (vs. caching in db) avoids a schema migration and
// keeps the persona text fresh if the operator edits agent.md mid-session.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFm } from "../../vault/frontmatter";

// VOS-106 T11.4: cap persona body to avoid macOS E2BIG on spawn. The body
// is passed inline via argv (`--append-system-prompt <body>`); ARG_MAX is
// ~256KB on macOS and ~128KB on some Linux configs, shared with all other
// argv + env. 32KB leaves comfortable headroom for the rest of argv (we
// also carry --settings, --mcp-config, --prompt, etc.) and is several
// pages of dense markdown — more than any realistic agent.md needs.
//
// Why argv-inline and not `--append-system-prompt-file`: CC 2.x advertises
// `--append-system-prompt[-file]` only in the `--bare` description, and the
// top-level help exposes only `--append-system-prompt <prompt>`. Until the
// file variant is officially documented we keep the argv path and bound it.
export const PERSONA_BODY_LIMIT = 32 * 1024;

export interface ReadPersonaResult {
  /** The markdown body with YAML frontmatter stripped, trimmed.
   *  Empty string when agent.md is missing, unreadable, or has no body. */
  body: string;
  /** Best-effort reason — surfaced to traces so an operator can tell
   *  "no persona configured" apart from "file missing" or "truncated". */
  reason?: "missing" | "empty" | "parse_error" | "ok" | "truncated";
}

/**
 * Read `<vaultRoot>/agents/<agentName>/agent.md`, strip frontmatter, return
 * the body. Tolerant: any failure returns an empty body with a reason flag
 * rather than throwing — a missing persona must not crash spawn.
 *
 * If the body exceeds {@link PERSONA_BODY_LIMIT}, it is truncated at the
 * limit and a marker comment is appended so the model can see it was cut.
 */
export function readAgentPersonaBody(
  vaultRoot: string,
  agentName: string,
): ReadPersonaResult {
  const filePath = join(vaultRoot, "agents", agentName, "agent.md");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { body: "", reason: "missing" };
  }
  let parsed: { body: string };
  try {
    // parseFm (gray-matter) tolerates frontmatter-less input: it returns
    // `{ data: {}, body: <full content> }`. A throw here means truly
    // malformed YAML, which is the legitimate `parse_error` signal.
    parsed = parseFm(raw);
  } catch {
    return { body: "", reason: "parse_error" };
  }
  const body = parsed.body.trim();
  if (body.length === 0) return { body: "", reason: "empty" };

  if (Buffer.byteLength(body, "utf8") > PERSONA_BODY_LIMIT) {
    const original = Buffer.byteLength(body, "utf8");
    // Slice on byte boundary, not code-point — avoids the marker pushing us
    // back over ARG_MAX. The trailing partial UTF-8 is harmless inside a
    // truncated comment context (and we re-decode lossily via Buffer).
    const truncated = Buffer.from(body, "utf8")
      .subarray(0, PERSONA_BODY_LIMIT)
      .toString("utf8");
    const marker = `\n\n<!-- persona truncated at ${PERSONA_BODY_LIMIT} bytes (was ${original} bytes) -->`;
    return { body: truncated + marker, reason: "truncated" };
  }

  return { body, reason: "ok" };
}
