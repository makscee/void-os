// HTTP shims for the daemon chat API (VOS-79 contract).
//
// Routes used:
//   POST /chats                  { agent? }   → { id, title, created_at }
//   POST /chat/:id/message       { text }     → { run_id, status }
//   GET  /chats                                → ChatSummary[] (recent-first)
//   GET  /chat/:id/messages                    → ReplayMessage[]
//
// Errors surface as thrown ApiError so callers can branch on `.status`.
// Default base URL matches the WS port (DAEMON_URL in main.ts).

import type { ReplayMessage } from "./reducer";

export const DEFAULT_DAEMON_HTTP = "http://127.0.0.1:7777";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? `daemon HTTP ${status}`);
    this.name = "ApiError";
  }
}

export type RunStatus = "running" | "done" | "error" | "cancelled" | string;

export interface ChatSummary {
  id: string;
  agent: string;
  /** Daemon may return null until titler runs; UI falls back to last_msg. */
  title: string | null;
  /** Last message text (any role); UI truncates for preview. */
  last_msg: string | null;
  /** Unix ms; used for recent-first ordering on the daemon side. */
  updated_at: number;
  /** Last run terminal status; null if no runs yet. */
  last_run_status: RunStatus | null;
}

export interface ChatApi {
  createChat(agent?: string): Promise<{ id: string; title: string; created_at: number }>;
  postMessage(chatId: string, text: string): Promise<{ run_id: string; status: string }>;
  listChats(): Promise<ChatSummary[]>;
  getMessages(chatId: string): Promise<ReplayMessage[]>;
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

function normalizeReplay(raw: unknown): ReplayMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplayMessage[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const role = o.role;
    const ts = typeof o.ts === "number" ? (o.ts as number) : undefined;
    if (role === "user" || role === "assistant") {
      if (typeof o.content !== "string") continue;
      out.push({ role, content: o.content, ts });
      continue;
    }
    if (role === "tool_use") {
      const toolCallId = o.tool_call_id;
      const name = o.name;
      if (typeof toolCallId !== "string" || typeof name !== "string") continue;
      const input =
        o.input && typeof o.input === "object" && !Array.isArray(o.input)
          ? (o.input as Record<string, unknown>)
          : {};
      out.push({ role: "tool_use", tool_call_id: toolCallId, name, input, ts });
      continue;
    }
    if (role === "tool_result") {
      const toolCallId = o.tool_call_id;
      if (typeof toolCallId !== "string") continue;
      // output may be a plain string or an Anthropic-style content block
      // array; pass through and let the reducer flatten for display.
      const output: string | Array<{ type?: string; text?: string }> =
        typeof o.output === "string"
          ? (o.output as string)
          : Array.isArray(o.output)
            ? (o.output as Array<{ type?: string; text?: string }>)
            : "";
      const isError = o.is_error === true;
      out.push({
        role: "tool_result",
        tool_call_id: toolCallId,
        output,
        is_error: isError,
        ts,
      });
      continue;
    }
  }
  return out;
}

function normalizeChats(raw: unknown): ChatSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatSummary[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string") continue;
    out.push({
      id: o.id,
      agent: typeof o.agent === "string" ? o.agent : "maya",
      title: typeof o.title === "string" ? o.title : null,
      last_msg: typeof o.last_msg === "string" ? o.last_msg : null,
      updated_at: typeof o.updated_at === "number" ? o.updated_at : 0,
      last_run_status:
        typeof o.last_run_status === "string" ? (o.last_run_status as RunStatus) : null,
    });
  }
  return out;
}

export function makeChatApi(
  base: string = DEFAULT_DAEMON_HTTP,
  fetchImpl: typeof fetch = fetch,
): ChatApi {
  return {
    async createChat(agent = "maya") {
      const res = await fetchImpl(`${base}/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      return jsonOrThrow(res) as Promise<{ id: string; title: string; created_at: number }>;
    },
    async postMessage(chatId, text) {
      const res = await fetchImpl(`${base}/chat/${encodeURIComponent(chatId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return jsonOrThrow(res) as Promise<{ run_id: string; status: string }>;
    },
    async listChats() {
      const res = await fetchImpl(`${base}/chats`, { method: "GET" });
      const body = await jsonOrThrow(res);
      return normalizeChats(body);
    },
    async getMessages(chatId) {
      const res = await fetchImpl(
        `${base}/chat/${encodeURIComponent(chatId)}/messages`,
        { method: "GET" },
      );
      const body = await jsonOrThrow(res);
      return normalizeReplay(body);
    },
  };
}
