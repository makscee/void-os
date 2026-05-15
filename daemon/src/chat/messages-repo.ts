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
    appendMessage(taskId, contextId, runId, role, parts, ts) {
      const t = ts ?? Date.now();
      const partsJson = JSON.stringify(parts);
      const partsText = flattenText(parts);

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
          "SELECT m.role AS role, m.parts AS parts, m.ts AS ts, r.status AS run_status " +
            "FROM messages m LEFT JOIN runs r ON r.id = m.run_id " +
            "WHERE m.context_id = ? ORDER BY m.ts ASC, m.ord ASC",
        )
        .all(contextId) as Array<{
          role: "ROLE_USER" | "ROLE_AGENT";
          parts: string;
          ts: number;
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
        const text = parts
          .filter(
            (p): p is { text: string } =>
              typeof (p as { text?: unknown }).text === "string",
          )
          .map((p) => (p as { text: string }).text)
          .join("\n");
        if (text) {
          const entry: ReplayEntry = {
            role: surfaceRole,
            content: text,
            ts: r.ts,
          };
          if (surfaceRole === "assistant" && r.run_status === "cancelled") {
            (entry as { cancelled?: boolean }).cancelled = true;
          }
          out.push(entry);
        }
        for (const p of parts) {
          const data = (p as { data?: { kind?: string } }).data;
          if (!data) continue;
          if (data.kind === "tool_use") {
            out.push({
              role: "tool_use",
              tool_call_id:
                (data as { tool_call_id?: string }).tool_call_id ?? "",
              name: (data as { tool_name?: string }).tool_name ?? "",
              input: (data as { input?: unknown }).input ?? null,
              ts: r.ts,
            });
          } else if (data.kind === "tool_result") {
            out.push({
              role: "tool_result",
              tool_call_id:
                (data as { tool_call_id?: string }).tool_call_id ?? "",
              output: (data as { output?: unknown }).output ?? "",
              is_error: Boolean((data as { is_error?: unknown }).is_error),
              ts: r.ts,
            });
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
