// VOS-89 T7: terminal-state translator.
//
// Given a child task's terminal state, produce the MCP tool result the parent's
// ask_agent call should resolve with — or throw an AskAgentError when the child
// terminated non-successfully so the parent's tool invocation surfaces an error.
//
// Schema notes (verified against migrations 0007 + 0010 + 0011):
//   - `messages` rows store role as 'ROLE_USER' / 'ROLE_AGENT'; the flattened
//     text lives in `parts_text` (joined TextPart.text members).
//   - Per-task scoping uses `messages.task_id`.
//   - For "last assistant text", mirror chat/messages-repo.ts → lastAssistantText:
//     ORDER BY ts DESC, ord DESC LIMIT 1 over ROLE_AGENT rows.
//
// Empty-text agent rows (e.g. cancelled-before-text turns) are skipped via the
// `parts_text != ''` filter so we surface "(no message)" instead of an empty
// string — same intent as the orchestrator's stopped-badge handling.

import type { Database } from "bun:sqlite";
import { AskAgentError } from "./ask-agent-errors";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

export function translateChildResult(
  db: Database,
  childTaskId: string,
  state: string,
  childError: string | null,
): ToolResult {
  if (state === "TASK_STATE_COMPLETED") {
    const row = db
      .query(
        `SELECT parts_text FROM messages
         WHERE task_id = ? AND role = 'ROLE_AGENT' AND parts_text != ''
         ORDER BY ts DESC, ord DESC LIMIT 1`,
      )
      .get(childTaskId) as { parts_text: string | null } | undefined;
    const text =
      row && row.parts_text && row.parts_text.length > 0
        ? row.parts_text
        : "(no message)";
    return { content: [{ type: "text", text }] };
  }
  if (state === "TASK_STATE_FAILED") {
    throw new AskAgentError(`child task failed: ${childError ?? "unknown"}`);
  }
  if (state === "TASK_STATE_CANCELED") {
    throw new AskAgentError("child task cancelled");
  }
  throw new AskAgentError(`unexpected child state: ${state}`);
}
