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
import { extractTurnText } from "./util";

export interface Message {
  role: "user" | "assistant";
  content: string;
  ts?: number;
}

export interface SessionReplay {
  walk(chatId: string): Message[];
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
      if (!leaf) return [];

      // Pass 3: walk leaf → root via parent_uuid, dedupe cycles, then reverse.
      const pathIds: string[] = [];
      const seen = new Set<string>();
      let cur: string | undefined = leaf;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        pathIds.push(cur);
        const r = byId.get(cur);
        cur = r?.parent_uuid;
      }
      pathIds.reverse();

      const msgs: Message[] = [];
      for (const id of pathIds) {
        const r = byId.get(id);
        if (!r || !VISIBLE_TYPES.has(r.type)) continue;
        // CC JSONL records carry text at r.message.content[] as an array of
        // blocks. Pure tool_use turns extract to "" — skip them; S4 will
        // render tool calls separately via chat.tool_call/tool_result.
        const content = extractTurnText(r);
        if (!content) continue;
        msgs.push({
          role: r.type as "user" | "assistant",
          content,
          ts: r.ts,
        });
      }
      return msgs;
    },
  };
}
