// VOS-83 mig-0007: messages-repo (A2A 2-role + JSON parts shape).
//
// Replaces the legacy 4-method API (appendUser / appendAssistant /
// appendToolUse / appendToolResult) with a single `appendMessage(role,
// parts[])` writer. The new `messages` table created in migration 0007
// stores A2A v1.0 `Message` rows: parts is the JSON-serialized `Part[]`,
// parts_text is the flattened concatenation of TextPart.text members
// (joined by '\n') for cheap recap/last-msg display.
//
// Behaviour preserved across the rewrite:
//   - UPSERT on (context_id, run_id) when role='ROLE_AGENT' so the
//     orchestrator can call appendMessage repeatedly during a turn (the
//     last call's parts wins) — same contract as legacy appendAssistant.
//   - `walk(contextId)` returns ReplayEntry[] in the legacy wire shape
//     (text turns + tool_use / tool_result blocks) so the plugin S4 panel
//     renders unchanged. Tool blocks are decoded from DataParts whose
//     `data.kind` is `tool_use` or `tool_result`.
//   - LEFT JOIN runs surfaces `cancelled: true` on ROLE_AGENT entries
//     whose run.status='cancelled' (preserves the stopped-badge contract).
//   - `lastAssistantText(contextId)` returns parts_text from the most
//     recent ROLE_AGENT row (drives contexts/chats list previews).
//
// Ordering: `(ts ASC, ord ASC)` with `ord` a per-context monotonic
// counter (MAX(ord)+1) — needed because multiple parts under one A2A
// Message share a ts but each is a separate row in the legacy wire shape.

import type { Database } from "bun:sqlite";
import type { Part, Role } from "../types/a2a";
import type { ReplayEntry } from "./session-replay";

export interface MessagesRepo {
  /**
   * Insert (or UPSERT for ROLE_AGENT on same run_id) one A2A Message row.
   *  - role='ROLE_USER': always inserts.
   *  - role='ROLE_AGENT' with non-null runId: UPDATEs the existing agent
   *    row for this (context_id, run_id) if present (preserves the VOS-80
   *    cancel UPSERT contract — orchestrator may call multiple times
   *    during a turn and the final call wins). With null runId, always
   *    inserts.
   * Returns the row id.
   */
  appendMessage(
    taskId: string,
    contextId: string,
    runId: string | null,
    role: Role,
    parts: Part[],
    ts?: number,
    /**
     * VOS-104 T8b: optional override for the flattened `parts_text` column.
     * Used by the ask-user-bridge to surface the question text in chat-list
     * previews even though the row's parts payload is a tool_use DataPart
     * (which would otherwise produce an empty parts_text and cause the row
     * to be filtered out by ChatList's isEmpty predicate).
     */
    partsTextOverride?: string,
  ): number;

  walk(contextId: string): ReplayEntry[];
  lastAssistantText(contextId: string): string;
}

const flattenText = (parts: Part[]): string =>
  parts
    .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
    .map((p) => (p as { text: string }).text)
    .join("\n");

export function makeMessagesRepo(db: Database): MessagesRepo {
  const nextOrd = (contextId: string): number => {
    const row = db
      .query(
        "SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM messages WHERE context_id = ?",
      )
      .get(contextId) as { n: number };
    return row.n;
  };

  return {
    appendMessage(taskId, contextId, runId, role, parts, ts, partsTextOverride) {
      const t = ts ?? Date.now();
      const partsJson = JSON.stringify(parts);
      const partsText = partsTextOverride ?? flattenText(parts);

      if (role === "ROLE_AGENT" && runId !== null) {
        const existing = db
          .query(
            "SELECT id FROM messages WHERE context_id = ? AND run_id = ? AND role = 'ROLE_AGENT' LIMIT 1",
          )
          .get(contextId, runId) as { id: number } | null;
        if (existing) {
          db.run(
            "UPDATE messages SET parts = ?, parts_text = ?, ts = ? WHERE id = ?",
            [partsJson, partsText, t, existing.id],
          );
          return existing.id;
        }
      }
      const result = db.run(
        "INSERT INTO messages (task_id, context_id, run_id, role, parts, parts_text, ts, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [taskId, contextId, runId, role, partsJson, partsText, t, nextOrd(contextId)],
      );
      return Number(result.lastInsertRowid);
    },

    walk(contextId) {
      const rows = db
        .query(
          "SELECT m.role AS role, m.parts AS parts, m.ts AS ts, m.task_id AS task_id, r.status AS run_status " +
            "FROM messages m LEFT JOIN runs r ON r.id = m.run_id " +
            "WHERE m.context_id = ? ORDER BY m.ts ASC, m.ord ASC",
        )
        .all(contextId) as Array<{
          role: "ROLE_USER" | "ROLE_AGENT";
          parts: string;
          ts: number;
          task_id: string;
          run_status: string | null;
        }>;

      const out: ReplayEntry[] = [];
      for (const r of rows) {
        let parts: Part[];
        try {
          parts = JSON.parse(r.parts) as Part[];
        } catch {
          parts = [];
        }
        const surfaceRole = r.role === "ROLE_USER" ? "user" : "assistant";
        // VOS-114: emit parts in their stored chronological order. The previous
        // implementation emitted the concatenated text once UP FRONT and then
        // tool entries AFTER, which inverted the natural sequence for the common
        // tool-then-text turn (Bash ls → "here's what I found"). The chat-row
        // reducer creates a new assistant bubble per assistant ReplayEntry, so
        // emission order is the rendered order. Group consecutive text parts so
        // we don't fragment the assistant bubble.
        const isCancelledAgent =
          surfaceRole === "assistant" && r.run_status === "cancelled";
        const rowStartIdx = out.length;
        let textBuf: string[] = [];
        const flushText = (): void => {
          if (textBuf.length === 0) return;
          out.push({
            role: surfaceRole,
            content: textBuf.join("\n"),
            ts: r.ts,
            task_id: r.task_id,
          });
          textBuf = [];
        };
        for (const p of parts) {
          if (typeof (p as { text?: unknown }).text === "string") {
            textBuf.push((p as { text: string }).text);
            continue;
          }
          const data = (p as { data?: { kind?: string } }).data;
          if (!data) continue;
          // Flush accumulated text before a tool entry so prose stays anchored
          // to its position in the part stream.
          flushText();
          if (data.kind === "tool_use") {
            out.push({
              role: "tool_use",
              tool_call_id:
                (data as { tool_call_id?: string }).tool_call_id ?? "",
              name: (data as { tool_name?: string }).tool_name ?? "",
              input: (data as { input?: unknown }).input ?? null,
              ts: r.ts,
              task_id: r.task_id,
            });
          } else if (data.kind === "tool_result") {
            out.push({
              role: "tool_result",
              tool_call_id:
                (data as { tool_call_id?: string }).tool_call_id ?? "",
              output: (data as { output?: unknown }).output ?? "",
              is_error: Boolean((data as { is_error?: unknown }).is_error),
              ts: r.ts,
              task_id: r.task_id,
            });
          } else if (data.kind === "denial") {
            // VOS-109: synthesised denial DataPart unpacked into a "denial"
            // replay row. Wire-side field names mirror the DataPart payload
            // (toolCallId / attemptedPath) but converted to snake_case to
            // match the rest of the replay union (tool_use / tool_result).
            // The plugin reducer's `replayToMessages` consumes this row
            // shape and attaches a DenialPart to the nearest preceding
            // assistant turn.
            out.push({
              role: "denial",
              tool_call_id:
                (data as { toolCallId?: string }).toolCallId ?? "",
              reason:
                ((data as { reason?: string }).reason as "scope_violation") ??
                "scope_violation",
              attempted_path:
                (data as { attemptedPath?: string }).attemptedPath ?? "",
              agent: (data as { agent?: string }).agent ?? "",
              message: (data as { message?: string }).message ?? "",
              ts: r.ts,
              task_id: r.task_id,
            });
          }
        }
        flushText();
        // VOS-80 stopped-badge contract: if the run cancelled, surface the ↯
        // pill. If text already streamed for this row, tag the first emitted
        // assistant entry. Otherwise emit an empty assistant entry so the UI
        // has a row to render the pill on.
        if (isCancelledAgent) {
          if (out.length === rowStartIdx) {
            const entry: ReplayEntry & { cancelled?: boolean } = {
              role: surfaceRole,
              content: "",
              ts: r.ts,
              task_id: r.task_id,
            };
            entry.cancelled = true;
            out.push(entry);
          } else {
            const first = out[rowStartIdx] as ReplayEntry & {
              cancelled?: boolean;
            };
            if (first.role === "assistant") first.cancelled = true;
          }
        }
      }
      return out;
    },

    lastAssistantText(contextId) {
      const row = db
        .query(
          "SELECT parts_text FROM messages WHERE context_id = ? AND role = 'ROLE_AGENT' ORDER BY ts DESC, ord DESC LIMIT 1",
        )
        .get(contextId) as { parts_text: string | null } | null;
      return row?.parts_text ?? "";
    },
  };
}
