// HTTP shims for the daemon chat API (VOS-79 contract).
//
// Routes used:
//   POST /chats                  { agent? }   → { id, title, created_at }
//   POST /chat/:id/message       { text }     → { run_id, status }
//   POST /chat/:id/cancel        (no body)    → { run_id, status:"cancelled" }
//                                              | 409 {error:"no_active_run"}
//                                              | 404 {error:"not_found"}
//   POST /chat/:id/answer        { tool_use_id, answer }
//                                              → { ok:true }
//                                              | 400/404/409 { error }
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
  /** Lifetime aggregate cost in USD; defaults to 0 when missing/invalid. */
  cost_usd: number;
  /** True iff any task in this chat is in TASK_STATE_INPUT_REQUIRED. */
  input_required: boolean;
  /** Latest run's context token usage (sum of input/output/cache splits). null until set. */
  context_tokens: number | null;
  context_input_tokens: number | null;
  context_output_tokens: number | null;
  context_cache_create_tokens: number | null;
  context_cache_read_tokens: number | null;
}

export interface ChatApi {
  createChat(agent?: string): Promise<{ id: string; title: string; created_at: number }>;
  postMessage(chatId: string, text: string): Promise<{ run_id: string; status: string }>;
  /** POST /chat/:id/cancel. Resolves with the cancel body on 200. Throws
   *  ApiError on 404/500. For the 409 "no_active_run" case the caller usually
   *  wants to treat it as a no-op rather than as a failure, so we surface a
   *  shaped result `{noActiveRun: true}` instead of throwing. */
  cancel(chatId: string): Promise<
    | { run_id: string; status: string; noActiveRun?: false }
    | { noActiveRun: true }
  >;
  /** POST /chat/:id/answer. Resolves an open ask_user prompt.
   *  - 200 → { ok: true }
   *  - 400/404/409 → { ok: false, status, error } (no throw)
   *  - network/parse error → throws ApiError or the underlying TypeError */
  answer(chatId: string, toolUseId: string, answer: string): Promise<
    | { ok: true }
    | { ok: false; status: 400 | 404 | 409; error: string }
  >;
  listChats(): Promise<ChatSummary[]>;
  getMessages(chatId: string): Promise<ReplayMessage[]>;
  /** GET /cost/today. Returns the 4-token-split daily total with non-neg integer
   *  coercion per field (else 0). VOS-110 T5 — backs the live CostMeter widget. */
  getCostToday(): Promise<{
    total: {
      input_tokens: number;
      output_tokens: number;
      cache_create_tokens: number;
      cache_read_tokens: number;
    };
  }>;
}

export async function jsonOrThrow(res: Response): Promise<unknown> {
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
    // VOS-91 T19: surface task_id through normalize so the reducer rebuild
    // can partition child-task replay entries into childTasks[cid].messages.
    // Stripping it broke reload-replay assertions (chunks vanished from the
    // expanded sub-thread body after page reload).
    const taskId = typeof o.task_id === "string" ? (o.task_id as string) : undefined;
    if (role === "user" || role === "assistant") {
      if (typeof o.content !== "string") continue;
      const entry: ReplayMessage = { role, content: o.content, ts };
      if (taskId !== undefined) (entry as { task_id?: string }).task_id = taskId;
      // Daemon's messages-repo stamps cancelled=true on assistant rows
      // belonging to a cancelled run (VOS-80). Surface so the renderer
      // shows the "stopped" badge from server truth.
      if (role === "assistant" && o.cancelled === true) {
        (entry as { cancelled?: boolean }).cancelled = true;
      }
      out.push(entry);
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
      const entry: ReplayMessage = { role: "tool_use", tool_call_id: toolCallId, name, input, ts };
      if (taskId !== undefined) (entry as { task_id?: string }).task_id = taskId;
      out.push(entry);
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
      const entry: ReplayMessage = {
        role: "tool_result",
        tool_call_id: toolCallId,
        output,
        is_error: isError,
        ts,
      };
      if (taskId !== undefined) (entry as { task_id?: string }).task_id = taskId;
      out.push(entry);
      continue;
    }
    if (role === "child_task_started") {
      // T7 synthetic entry — passthrough so reducer's refetched handler
      // can rebuild childTasks across refetches. Reducer casts via
      // `as unknown as Array<ReplayMessage & {...}>` at the read site.
      out.push(o as unknown as ReplayMessage);
      continue;
    }
    if (role === "denial") {
      // VOS-109: synthesised denial row from messages-repo. Mirror the
      // daemon-side DataPart{data:{kind:"denial",...}} payload as a flat
      // ReplayMessage so the reducer's `replayToMessages` attaches a
      // DenialPart to the nearest preceding assistant turn.
      const toolCallId = o.tool_call_id;
      if (typeof toolCallId !== "string") continue;
      const reasonRaw = typeof o.reason === "string" ? (o.reason as string) : "scope_violation";
      const reason: "scope_violation" = reasonRaw === "scope_violation" ? "scope_violation" : "scope_violation";
      const attemptedPath = typeof o.attempted_path === "string" ? (o.attempted_path as string) : "";
      const agent = typeof o.agent === "string" ? (o.agent as string) : "";
      const message = typeof o.message === "string" ? (o.message as string) : "";
      const entry: ReplayMessage = {
        role: "denial",
        tool_call_id: toolCallId,
        reason,
        attempted_path: attemptedPath,
        agent,
        message,
        ts,
      };
      if (taskId !== undefined) (entry as { task_id?: string }).task_id = taskId;
      out.push(entry);
      continue;
    }
  }
  return out;
}

function asNonNegIntOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
}

function normalizeChats(raw: unknown): ChatSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatSummary[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string") continue;
    if (typeof o.agent !== "string") continue; // T3 guarantees agent is always set; skip corrupted/legacy rows
    out.push({
      id: o.id,
      agent: o.agent,
      title: typeof o.title === "string" ? o.title : null,
      last_msg: typeof o.last_msg === "string" ? o.last_msg : null,
      updated_at: typeof o.updated_at === "number" ? o.updated_at : 0,
      last_run_status:
        typeof o.last_run_status === "string" ? (o.last_run_status as RunStatus) : null,
      cost_usd:
        typeof o.cost_usd === "number" && Number.isFinite(o.cost_usd) && o.cost_usd >= 0
          ? o.cost_usd
          : 0,
      input_required: o.input_required === true,
      context_tokens: asNonNegIntOrNull(o.context_tokens),
      context_input_tokens: asNonNegIntOrNull(o.context_input_tokens),
      context_output_tokens: asNonNegIntOrNull(o.context_output_tokens),
      context_cache_create_tokens: asNonNegIntOrNull(o.context_cache_create_tokens),
      context_cache_read_tokens: asNonNegIntOrNull(o.context_cache_read_tokens),
    });
  }
  return out;
}

export function makeChatApi(
  base: string = DEFAULT_DAEMON_HTTP,
  fetchImpl: typeof fetch = fetch,
): ChatApi {
  return {
    async createChat(agent?: string) {
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
    async cancel(chatId) {
      const res = await fetchImpl(
        `${base}/chat/${encodeURIComponent(chatId)}/cancel`,
        { method: "POST" },
      );
      // 409 = no active run. Treat as benign no-op so the runtime can keep
      // moving (queue flush still fires via run.end echo from a prior run).
      if (res.status === 409) {
        // Drain body for parity with jsonOrThrow's body-read.
        try { await res.text(); } catch { /* ignore */ }
        return { noActiveRun: true };
      }
      const body = await jsonOrThrow(res);
      return body as { run_id: string; status: string };
    },
    async answer(chatId, toolUseId, answer) {
      const res = await fetchImpl(
        `${base}/chat/${encodeURIComponent(chatId)}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool_use_id: toolUseId, answer }),
        },
      );
      if (res.ok) return { ok: true } as const;
      if (res.status === 400 || res.status === 404 || res.status === 409) {
        let body: unknown = null;
        try {
          const text = await res.text();
          if (text) body = JSON.parse(text);
        } catch { /* ignore */ }
        const error =
          body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error
            : `http_${res.status}`;
        return { ok: false, status: res.status as 400 | 404 | 409, error };
      }
      // Other unexpected statuses → use the shared error path.
      throw new ApiError(res.status, await res.text().catch(() => null));
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
    async getCostToday() {
      const res = await fetchImpl(`${base}/cost/today`, { method: "GET" });
      const body = await jsonOrThrow(res);
      const t =
        body && typeof body === "object" && "total" in body && body.total && typeof body.total === "object"
          ? (body.total as Record<string, unknown>)
          : {};
      const num = (v: unknown): number =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
      return {
        total: {
          input_tokens: num(t.input_tokens),
          output_tokens: num(t.output_tokens),
          cache_create_tokens: num(t.cache_create_tokens),
          cache_read_tokens: num(t.cache_read_tokens),
        },
      };
    },
  };
}
