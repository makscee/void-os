// VOS-80 architecture (a): sessionReplay now reads from the canonical
// `messages` table — NOT CC's filesystem JSONL.
//
// Why: CC does not journal killed-mid-stream turns to its on-disk JSONL,
// so partial assistant text from cancel/error never reached
// GET /chat/:id/messages. The daemon's messages table is now the single
// source of truth; the orchestrator persists every user/assistant/tool
// event into it (see chat/messages-repo.ts and chat/orchestrator.ts).
//
// Legacy migration: chats created before this rollout have history only
// in CC's JSONL. On the first walk() for such a chat — DB has no rows
// but chat.session_id is set — we parse the JSONL once, seed the
// messages table, then return DB rows. Subsequent walks read from DB
// directly. New turns always go to DB; the JSONL is read-only history.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import { makeChatRepo, openTaskFor } from "./repo";
import { makeMessagesRepo } from "./messages-repo";
import { extractTurnText, extractToolUses, extractToolResults } from "./util";
import type { Part, Role } from "../types/a2a";
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

export interface ReplayOpts {
  projectsRoot?: string;
  cwd?: string;
  // Test seam — production resolves slug from realpath(cwd).
  encodeCwd?: (cwd: string) => string;
}

const VISIBLE_TYPES = new Set(["user", "assistant"]);

function defaultEncode(cwd: string): string {
  // realpath collapses macOS /tmp → /private/tmp, symlinks, ../ etc.
  return realpathSync(cwd).replace(/\//g, "-");
}

interface JsonlRecord {
  uuid: string;
  parent_uuid?: string;
  type: string;
  message?: unknown;
  ts?: number;
  [k: string]: unknown;
}

/** Walk a JSONL record into ReplayEntry rows in surface order (text →
 * tool_use|tool_result blocks). Mirrors the pre-VOS-80 in-memory DAG
 * walk so the seeded DB rows match the previously-served wire shape. */
function recordToEntries(r: JsonlRecord): ReplayEntry[] {
  if (!VISIBLE_TYPES.has(r.type)) return [];
  const role = r.type as "user" | "assistant";
  const out: ReplayEntry[] = [];
  const text = extractTurnText(r);
  if (text) out.push({ role, content: text, ts: r.ts });
  if (role === "assistant") {
    for (const tu of extractToolUses(r)) {
      out.push({
        role: "tool_use",
        tool_call_id: tu.tool_call_id,
        name: tu.name,
        input: tu.input,
        ts: r.ts,
      });
    }
  } else {
    for (const tr of extractToolResults(r)) {
      out.push({
        role: "tool_result",
        tool_call_id: tr.tool_call_id,
        output: tr.output,
        is_error: tr.is_error,
        ts: r.ts,
      });
    }
  }
  return out;
}

/** Parse the JSONL and return the ordered visible-turn record list,
 * applying the same DAG-walk + file-order-fallback logic the old
 * sessionReplay used. Returns the records in chronological order. */
function legacyJsonlOrder(jsonlText: string): JsonlRecord[] {
  const byId = new Map<string, JsonlRecord>();
  const order: string[] = [];
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let obj: JsonlRecord;
    try {
      obj = JSON.parse(line) as JsonlRecord;
    } catch {
      continue;
    }
    if (!obj || typeof obj.uuid !== "string") continue;
    byId.set(obj.uuid, obj);
    order.push(obj.uuid);
  }
  // Pass 2: build parent_uuid DAG, locate the leaf.
  const hasChild = new Set<string>();
  for (const id of order) {
    const r = byId.get(id);
    if (r?.parent_uuid && byId.has(r.parent_uuid)) {
      hasChild.add(r.parent_uuid);
    }
  }
  const leaves = order.filter((id) => !hasChild.has(id));
  const leaf = leaves[leaves.length - 1];

  const pathIds: string[] = [];
  if (leaf) {
    const seen = new Set<string>();
    let cur: string | undefined = leaf;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      pathIds.push(cur);
      const r = byId.get(cur);
      cur = r?.parent_uuid;
    }
    pathIds.reverse();
  }

  const totalVisibleRecords = order.reduce((n, id) => {
    const r = byId.get(id);
    return r && VISIBLE_TYPES.has(r.type) ? n + 1 : n;
  }, 0);
  const dagVisibleRecords = pathIds.reduce((n, id) => {
    const r = byId.get(id);
    return r && VISIBLE_TYPES.has(r.type) ? n + 1 : n;
  }, 0);
  const chosen =
    dagVisibleRecords >= totalVisibleRecords ? pathIds : order;
  const records: JsonlRecord[] = [];
  for (const id of chosen) {
    const r = byId.get(id);
    if (r && VISIBLE_TYPES.has(r.type)) records.push(r);
  }
  return records;
}

export function makeSessionReplay(
  db: Database,
  opts: ReplayOpts = {},
): SessionReplay {
  const chatRepo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const root = opts.projectsRoot ?? join(homedir(), ".claude", "projects");
  const cwd = opts.cwd ?? process.cwd();
  const encode = opts.encodeCwd ?? defaultEncode;

  /** Seed messages table from the chat's CC JSONL. Returns true if any
   * rows were inserted (legacy import happened); false otherwise.
   *
   * Idempotency: caller must check that DB has no rows for the chat
   * before invoking. Inside, we use the running-counter ts/ord that
   * the messages-repo manages so the surface order matches the
   * pre-VOS-80 walk. */
  function importFromJsonl(chatId: string, sessionId: string): boolean {
    const slug = encode(cwd);
    const path = join(root, slug, `${sessionId}.jsonl`);
    if (!existsSync(path)) return false;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    const records = legacyJsonlOrder(text);
    if (records.length === 0) return false;

    // Per-context taskId — 0007's messages.task_id is NOT NULL. The chat
    // row was created via makeChatRepo.create which always mints a paired
    // open task, so this lookup is always defined for live code paths.
    const taskId = openTaskFor(db, chatId);

    // We assign synthetic ts values so the messages-repo (ts, ord) sort
    // recovers exactly the JSONL chronological order, even if individual
    // records lack a `ts` field. Use a monotonically-increasing counter
    // anchored at the first record's `ts` (or 0).
    let ts = 0;
    for (const r of records) {
      ts = typeof r.ts === "number" ? r.ts : ts + 1;
      const entries = recordToEntries(r);
      if (entries.length === 0) continue;

      // recordToEntries always emits a single role per record (the JSONL
      // record's outer `type` of "user" | "assistant"), so the first
      // entry's role determines the A2A role for the whole message.
      const isUser = entries[0]!.role === "user";
      const role: Role = isUser ? "ROLE_USER" : "ROLE_AGENT";
      const parts: Part[] = [];

      for (const entry of entries) {
        switch (entry.role) {
          case "user":
          case "assistant":
            if (entry.content) parts.push({ text: entry.content });
            break;
          case "tool_use":
            parts.push({
              data: {
                kind: "tool_use",
                tool_call_id: entry.tool_call_id,
                tool_name: entry.name,
                input: entry.input as Record<string, unknown>,
              },
            });
            break;
          case "tool_result": {
            const outText =
              typeof entry.output === "string"
                ? entry.output
                : (() => {
                    try {
                      return JSON.stringify(entry.output);
                    } catch {
                      return String(entry.output);
                    }
                  })();
            parts.push({
              data: {
                kind: "tool_result",
                tool_call_id: entry.tool_call_id,
                output: outText,
                is_error: entry.is_error,
              },
            });
            break;
          }
        }
      }
      if (parts.length === 0) continue;
      // run_id is null for legacy imports — no daemon-side run exists.
      messages.appendMessage(taskId, chatId, null, role, parts, ts);
    }
    return true;
  }

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

      // Fast path: DB has rows → that's the authoritative view.
      const existing = messages.walk(chatId);
      if (existing.length > 0) {
        surfaceTraceDiagnostics(chatId);
        // For tool_result entries imported from JSONL, the output field
        // was stringified to text by importFromJsonl when the source was
        // non-string. Live writes from the orchestrator (S2) already use
        // string outputs, so this round-trip is a no-op for new chats.
        return existing;
      }

      // Lazy JSONL import for legacy chats (created pre-VOS-80 messages
      // table). If chat has no session_id yet, there's nothing to import.
      // VOS-84 note: legacy chats read CC's native session JSONL format
      // (uuid/parent_uuid records), not the daemon-side VOS-84 envelope
      // trace. readTrace is therefore NOT a drop-in for the legacy
      // importFromJsonl path — see surfaceTraceDiagnostics for the
      // daemon-side trace surface.
      if (!chat.session_id) return [];
      const imported = importFromJsonl(chatId, chat.session_id);
      if (!imported) return [];
      return messages.walk(chatId);
    },
  };
}
