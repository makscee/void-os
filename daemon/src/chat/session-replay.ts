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
  task_id: string;
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
  task_id: string;
}

/** A tool result block lifted out of a user-role turn's content[]. */
export interface ToolResultEntry {
  role: "tool_result";
  tool_call_id: string;
  output: unknown;
  is_error: boolean;
  ts?: number;
  task_id: string;
}

/** Synthetic entry injected by session-replay.walk for each child task that
 * was started via an ask_agent tool_use on the parent task. Positioned
 * immediately after the parent's matching tool_use entry so the sub-thread
 * renders inline with its calling part. */
export interface ChildTaskStartedEntry {
  role: "child_task_started";
  chat_id: string;
  parent_task_id: string;
  parent_tool_call_id: string;
  child_task_id: string;
  agent: string;
  /** Snapshot of `tasks.state` at walk time. UI seeds initial state from this. */
  task_state: "SUBMITTED" | "WORKING" | "WAITING_ON_AGENT" | "INPUT_REQUIRED" | "COMPLETED" | "FAILED" | "CANCELED";
  ts: number;
  task_id: string; // = child_task_id, to keep the union task_id-tagged
}

/** Discriminated union surfaced to /chat/:id/messages. The plugin S4 panel
 * walks this list, rendering text turns inline and {tool_use, tool_result}
 * pairs in the tool-call panel keyed by tool_call_id. */
export type ReplayEntry =
  | TextMessage
  | ToolUseEntry
  | ToolResultEntry
  | ChildTaskStartedEntry;

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
        const entries: ReplayEntry[] = existing;

        // Splice synthetic child_task_started entries inline with the stream,
        // ordered by the parent tool_use part_index (NOT by child id alphabetical).
        // Guard: parent_tool_call_id column only exists in schemas >= migration
        // 0013; gracefully skip on older test databases.
        let childRows: Array<{
          id: string;
          parent_task_id: string;
          parent_tool_call_id: string;
          target_agent: string;
          state: string;
          created_at: number;
        }>;
        try {
          childRows = db
            .query(
              `SELECT t.id AS id, t.parent_task_id, t.parent_tool_call_id, t.target_agent, t.state, t.created_at
               FROM tasks t
               WHERE t.context_id = ? AND t.parent_tool_call_id IS NOT NULL`,
            )
            .all(chatId) as typeof childRows;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("no such column")) throw e;
          childRows = [];
        }

        if (childRows.length > 0) {
          // Build index: (parent_task_id::tool_call_id) → current position in entries.
          const toolUseOrd = new Map<string, number>();
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i] as any;
            if (e.role === "tool_use")
              toolUseOrd.set(`${e.task_id}::${e.tool_call_id}`, i);
          }

          for (const c of childRows) {
            const synthetic: ChildTaskStartedEntry = {
              role: "child_task_started" as const,
              chat_id: chatId,
              parent_task_id: c.parent_task_id,
              parent_tool_call_id: c.parent_tool_call_id,
              child_task_id: c.id,
              agent: c.target_agent,
              task_state: c.state.replace(
                /^TASK_STATE_/,
                "",
              ) as ChildTaskStartedEntry["task_state"],
              ts: c.created_at,
              task_id: c.id,
            };

            // Insertion position: just AFTER the parent's tool_use part for this
            // child (so the sub-thread renders inline with its calling part).
            // Fall back to BEFORE the child's first message ordered by ts.
            const tuKey = `${c.parent_task_id}::${c.parent_tool_call_id}`;
            const tuIdx = toolUseOrd.get(tuKey);
            let insertAt: number;
            if (tuIdx !== undefined) {
              insertAt = tuIdx + 1;
            } else {
              const childMsgIdx = entries.findIndex(
                (e: any) => e.task_id === c.id,
              );
              insertAt = childMsgIdx >= 0 ? childMsgIdx : entries.length;
            }

            entries.splice(insertAt, 0, synthetic);
            // Shift stored indices for all entries that moved up.
            for (const [k, v] of toolUseOrd.entries())
              if (v >= insertAt) toolUseOrd.set(k, v + 1);
          }
        }

        return entries;
      }
      return [];
    },
  };
}
