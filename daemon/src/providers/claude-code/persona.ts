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

export interface ReadPersonaResult {
  /** The markdown body with YAML frontmatter stripped, trimmed.
   *  Empty string when agent.md is missing, unreadable, or has no body. */
  body: string;
  /** Best-effort reason when body is empty — surfaced to traces so an
   *  operator can tell "no persona configured" apart from "file missing". */
  reason?: "missing" | "empty" | "parse_error" | "ok";
}

/**
 * Read `<vaultRoot>/agents/<agentName>/agent.md`, strip frontmatter, return
 * the body. Tolerant: any failure returns an empty body with a reason flag
 * rather than throwing — a missing persona must not crash spawn.
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
    parsed = parseFm(raw);
  } catch {
    return { body: "", reason: "parse_error" };
  }
  const body = parsed.body.trim();
  if (body.length === 0) return { body: "", reason: "empty" };
  return { body, reason: "ok" };
}
