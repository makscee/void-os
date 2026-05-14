// VOS-80 architecture (a): messages-repo.
//
// Canonical store for chat history. Replaces CC's filesystem JSONL as the
// source of truth for GET /chat/:id/messages so that partial assistant text
// from cancel / error mid-stream is surfaced — CC does NOT journal killed
// turns to its on-disk JSONL.
//
// Contract:
//   - appendUser     → inserts a 'user' row.
//   - appendAssistant→ UPSERT on (chat_id, run_id, role='assistant'): the
//                      orchestrator streams tokens and the assistant text
//                      grows; we call appendAssistant once at terminal (chat.completion,
//                      cancel, or error finally) with the full accumulated
//                      text and overwrite any prior row for this run.
//   - appendToolUse  → inserts a 'tool_use' row, input is a JSON-stringified
//                      payload. Caller stringifies; repo treats content as text.
//   - appendToolResult→ inserts a 'tool_result' row, output normalized to text.
//   - walk           → ordered list of ReplayEntry-shaped objects.
//   - lastAssistantText → latest assistant content for chats.last_msg.
//
// Ordering: SELECT … ORDER BY ts ASC, ord ASC. `ord` is a per-chat monotonic
// counter — needed because multiple tool_use blocks within one assistant
// turn share a ts. Maintained in SQL via (SELECT COALESCE(MAX(ord),0)+1 …).

import type { Database } from "bun:sqlite";
import type { ReplayEntry } from "./session-replay";

export interface MessagesRepo {
  appendUser(
    chatId: string,
    runId: string | null,
    text: string,
    ts?: number,
  ): void;
  /** UPSERT — if an assistant row exists for (chat_id, run_id), UPDATE its
   * content + ts; otherwise INSERT. Idempotent across multiple calls during
   * the same run (orchestrator streams tokens and writes the accumulated
   * text once at terminal). */
  appendAssistant(
    chatId: string,
    runId: string | null,
    text: string,
    ts?: number,
  ): void;
  appendToolUse(
    chatId: string,
    runId: string | null,
    toolCallId: string,
    name: string,
    inputJsonString: string,
    ts?: number,
  ): void;
  appendToolResult(
    chatId: string,
    runId: string | null,
    toolCallId: string,
    outputText: string,
    isError: boolean,
    ts?: number,
  ): void;
  walk(chatId: string): ReplayEntry[];
  lastAssistantText(chatId: string): string;
}

interface Row {
  role: "user" | "assistant" | "tool_use" | "tool_result";
  content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  is_error: number;
  ts: number;
}

function parseInput(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function makeMessagesRepo(db: Database): MessagesRepo {
  const nextOrd = (chatId: string): number => {
    const row = db
      .query(
        "SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM messages WHERE chat_id = ?",
      )
      .get(chatId) as { n: number };
    return row.n;
  };

  return {
    appendUser(chatId, runId, text, ts) {
      const t = ts ?? Date.now();
      db.run(
        "INSERT INTO messages (chat_id, run_id, role, content, ts, ord) VALUES (?, ?, 'user', ?, ?, ?)",
        [chatId, runId, text, t, nextOrd(chatId)],
      );
    },
    appendAssistant(chatId, runId, text, ts) {
      const t = ts ?? Date.now();
      // UPSERT keyed on (chat_id, run_id, role='assistant'). runId may be null
      // for legacy JSONL imports — in that case we always insert a fresh row.
      if (runId !== null) {
        const existing = db
          .query(
            "SELECT id FROM messages WHERE chat_id = ? AND run_id = ? AND role = 'assistant' LIMIT 1",
          )
          .get(chatId, runId) as { id: number } | null;
        if (existing) {
          db.run(
            "UPDATE messages SET content = ?, ts = ? WHERE id = ?",
            [text, t, existing.id],
          );
          return;
        }
      }
      db.run(
        "INSERT INTO messages (chat_id, run_id, role, content, ts, ord) VALUES (?, ?, 'assistant', ?, ?, ?)",
        [chatId, runId, text, t, nextOrd(chatId)],
      );
    },
    appendToolUse(chatId, runId, toolCallId, name, inputJsonString, ts) {
      const t = ts ?? Date.now();
      db.run(
        "INSERT INTO messages (chat_id, run_id, role, content, tool_call_id, tool_name, ts, ord) VALUES (?, ?, 'tool_use', ?, ?, ?, ?, ?)",
        [chatId, runId, inputJsonString, toolCallId, name, t, nextOrd(chatId)],
      );
    },
    appendToolResult(chatId, runId, toolCallId, outputText, isError, ts) {
      const t = ts ?? Date.now();
      db.run(
        "INSERT INTO messages (chat_id, run_id, role, content, tool_call_id, is_error, ts, ord) VALUES (?, ?, 'tool_result', ?, ?, ?, ?, ?)",
        [chatId, runId, outputText, toolCallId, isError ? 1 : 0, t, nextOrd(chatId)],
      );
    },
    walk(chatId) {
      const rows = db
        .query(
          "SELECT role, content, tool_call_id, tool_name, is_error, ts FROM messages WHERE chat_id = ? ORDER BY ts ASC, ord ASC",
        )
        .all(chatId) as Row[];
      const out: ReplayEntry[] = [];
      for (const r of rows) {
        if (r.role === "user" || r.role === "assistant") {
          out.push({ role: r.role, content: r.content ?? "", ts: r.ts });
        } else if (r.role === "tool_use") {
          out.push({
            role: "tool_use",
            tool_call_id: r.tool_call_id ?? "",
            name: r.tool_name ?? "",
            input: parseInput(r.content),
            ts: r.ts,
          });
        } else {
          out.push({
            role: "tool_result",
            tool_call_id: r.tool_call_id ?? "",
            output: r.content ?? "",
            is_error: r.is_error !== 0,
            ts: r.ts,
          });
        }
      }
      return out;
    },
    lastAssistantText(chatId) {
      const row = db
        .query(
          "SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY ts DESC, ord DESC LIMIT 1",
        )
        .get(chatId) as { content: string | null } | null;
      return row?.content ?? "";
    },
  };
}
