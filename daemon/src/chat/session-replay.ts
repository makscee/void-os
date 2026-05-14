// sessionReplay — single-JSONL DAG walk over CC's ~/.claude/projects/<slug>/<sid>.jsonl.
// Per VOS-79 plan (2026-05-14-vos-79-chat-lifecycle-endpoints.md), Task 4.
//
// Ground truth (T0 drill):
//   - claudev writes ONE JSONL per (cwd, session_id); --resume appends in place.
//   - File path: `<projectsRoot>/<slug>/<session_id>.jsonl`
//     where slug = realpath(cwd).replace(/\//g, "-"). macOS /tmp → /private/tmp.
//   - Records form a DAG keyed by `uuid` / `parent_uuid` over MIXED record types
//     (queue-operation, attachment, user, assistant, system, last-prompt, …).
//     To recover visible turns: walk leaf → root via parent_uuid, reverse, then
//     filter to {user, assistant}.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import { makeChatRepo } from "./repo";
import { extractTurnText, extractToolUses, extractToolResults } from "./util";

/** A visible text turn (user prompt or assistant narration). */
export interface TextMessage {
  role: "user" | "assistant";
  content: string;
  ts?: number;
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

/** @deprecated Use ReplayEntry — kept for source-compat in tests. */
export type Message = ReplayEntry;

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

interface Record {
  uuid: string;
  parent_uuid?: string;
  type: string;
  message?: unknown;
  ts?: number;
  [k: string]: unknown;
}

function collectVisible(
  ids: string[],
  byId: Map<string, Record>,
): ReplayEntry[] {
  const msgs: ReplayEntry[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || !VISIBLE_TYPES.has(r.type)) continue;
    const role = r.type as "user" | "assistant";

    // Per-turn surface order matches the content[] block order so the S4
    // panel can render text + tool_use as they were emitted:
    //   1. text portion (if any) as a TextMessage
    //   2. each tool_use block (assistant turns only, in block order)
    //   3. each tool_result block (user turns only, in block order)
    // A turn yielding zero entries (e.g. an empty user record) is skipped.
    const text = extractTurnText(r);
    if (text) {
      msgs.push({ role, content: text, ts: r.ts });
    }
    if (role === "assistant") {
      for (const tu of extractToolUses(r)) {
        msgs.push({
          role: "tool_use",
          tool_call_id: tu.tool_call_id,
          name: tu.name,
          input: tu.input,
          ts: r.ts,
        });
      }
    } else {
      // role === "user": surface tool_result blocks (CC encodes them on
      // user-role records). The user's typed prompt is the text branch
      // above; tool_result is the separate entry.
      for (const tr of extractToolResults(r)) {
        msgs.push({
          role: "tool_result",
          tool_call_id: tr.tool_call_id,
          output: tr.output,
          is_error: tr.is_error,
          ts: r.ts,
        });
      }
    }
  }
  return msgs;
}

export function makeSessionReplay(
  db: Database,
  opts: ReplayOpts = {},
): SessionReplay {
  const repo = makeChatRepo(db);
  const root = opts.projectsRoot ?? join(homedir(), ".claude", "projects");
  const cwd = opts.cwd ?? process.cwd();
  const encode = opts.encodeCwd ?? defaultEncode;

  return {
    walk(chatId) {
      const chat = repo.get(chatId);
      if (!chat || !chat.session_id) return [];
      const slug = encode(cwd);
      const path = join(root, slug, `${chat.session_id}.jsonl`);
      if (!existsSync(path)) return [];

      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return [];
      }

      // Pass 1: parse every line into a uuid→record map. Skip malformed lines.
      const byId = new Map<string, Record>();
      const order: string[] = []; // file order — used as a leaf-detection tiebreaker.
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let obj: Record;
        try {
          obj = JSON.parse(line) as Record;
        } catch {
          continue;
        }
        if (!obj || typeof obj.uuid !== "string") continue;
        byId.set(obj.uuid, obj);
        order.push(obj.uuid);
      }

      // Pass 2: build parent_uuid DAG, locate the leaf (no record claims it as parent).
      const hasChild = new Set<string>();
      for (const id of order) {
        const r = byId.get(id);
        if (r?.parent_uuid && byId.has(r.parent_uuid)) {
          hasChild.add(r.parent_uuid);
        }
      }
      const leaves = order.filter((id) => !hasChild.has(id));
      // Single conversation thread: take the latest leaf in file order.
      const leaf = leaves[leaves.length - 1];

      // Pass 3: walk leaf → root via parent_uuid, dedupe cycles, then reverse.
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

      const dagMsgs = collectVisible(pathIds, byId);

      // Defense-in-depth: newer CC builds emit visible turns with no
      // parent_uuid (the chain runs through queue-operation/attachment records
      // that we filter out by type). When the DAG walk reaches fewer visible
      // records than the file actually contains, fall back to file-order
      // traversal of every visible record. We count *records* (not output
      // entries), since one record can emit multiple ReplayEntries (text +
      // N tool_use, or multiple tool_result blocks). The JSONL is append-only,
      // so file order is chronological for the visible-turn subsequence.
      const totalVisibleRecords = order.reduce((n, id) => {
        const r = byId.get(id);
        return r && VISIBLE_TYPES.has(r.type) ? n + 1 : n;
      }, 0);
      const dagVisibleRecords = pathIds.reduce((n, id) => {
        const r = byId.get(id);
        return r && VISIBLE_TYPES.has(r.type) ? n + 1 : n;
      }, 0);
      if (dagVisibleRecords >= totalVisibleRecords) return dagMsgs;
      return collectVisible(order, byId);
    },
  };
}
