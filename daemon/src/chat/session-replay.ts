// session-replay reads the canonical `messages` table as the single source
// of truth for /chat/:id/messages. The orchestrator persists every
// user/assistant/tool event into it (see chat/messages-repo.ts and
// chat/orchestrator.ts), and the API layer walks this view.
//
// Pre-VOS-80 legacy import (CC JSONL → messages table seed) was removed in
// VOS-99 after confirming no live data depended on it. See ADR-0001
// `## Amendments` (2026-05-16) for the seam decision history.

import type { Database } from "bun:sqlite";
import { makeChatRepo } from "./repo";
import { makeMessagesRepo } from "./messages-repo";
import { readTrace } from "../trace/reader";

/** A visible text turn (user prompt or assistant narration). */
export interface TextMessage {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  /** True when this assistant turn's run was marked cancelled (ESC cancel).
   *  Surfaced via LEFT JOIN runs in messages-repo.walk() so the plugin can
   *  render a "stopped" badge on the cached server-truth entry without
   *  relying on the optimistic pendingStoppedRunId path. Always omitted for
   *  user entries. */
  cancelled?: boolean;
}

/** A tool invocation block lifted out of an assistant turn's content[]. */
export interface ToolUseEntry {
  role: "tool_use";
  tool_call_id: string;
  name: string;
  input: unknown;
  ts?: number;
}

/** A tool result block lifted out of a user-role turn's content[]. */
export interface ToolResultEntry {
  role: "tool_result";
  tool_call_id: string;
  output: unknown;
  is_error: boolean;
  ts?: number;
}

/** Discriminated union surfaced to /chat/:id/messages. The plugin S4 panel
 * walks this list, rendering text turns inline and {tool_use, tool_result}
 * pairs in the tool-call panel keyed by tool_call_id. */
export type ReplayEntry = TextMessage | ToolUseEntry | ToolResultEntry;

export interface SessionReplay {
  walk(chatId: string): ReplayEntry[];
}

export function makeSessionReplay(db: Database): SessionReplay {
  const chatRepo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);

  // VOS-84: surface partial/gap diagnostics from the daemon-side VOS-84
  // trace for the chat's most-recent run. The messages table remains the
  // authoritative view for /chat/:id/messages (per VOS-80a), so the trace
  // diagnostics are advisory — they help operators notice torn JSONL or
  // dropped sequences without changing the wire shape returned to callers.
  function surfaceTraceDiagnostics(chatId: string): void {
    type Row = { trace_path: string | null } | undefined;
    const row = db
      .query(
        "SELECT trace_path FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(chatId) as Row;
    if (!row || !row.trace_path) return;
    const { records, gaps, recoveredPartial } = readTrace(row.trace_path);
    if (recoveredPartial) {
      console.warn(
        `session-replay: trace ${row.trace_path} had partial trailing line, recovered ${records.length} records`,
      );
    }
    if (gaps.length > 0) {
      console.warn(
        `session-replay: trace ${row.trace_path} has ${gaps.length} gap(s):`,
        gaps,
      );
    }
  }

  return {
    walk(chatId) {
      const chat = chatRepo.get(chatId);
      if (!chat) return [];
      const existing = messages.walk(chatId);
      if (existing.length > 0) {
        surfaceTraceDiagnostics(chatId);
        return existing;
      }
      return [];
    },
  };
}
