// HTTP shims for the daemon chat API (VOS-79 contract).
//
// Routes used in S2:
//   POST /chats              { agent? }   → { id, title, created_at }
//   POST /chat/:id/message   { text }     → { run_id, status }
//
// Errors surface as thrown ApiError so callers can branch on `.status`.
// Default base URL matches the WS port (DAEMON_URL in main.ts).

export const DEFAULT_DAEMON_HTTP = "http://127.0.0.1:7777";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? `daemon HTTP ${status}`);
    this.name = "ApiError";
  }
}

export interface ChatApi {
  createChat(agent?: string): Promise<{ id: string; title: string; created_at: number }>;
  postMessage(chatId: string, text: string): Promise<{ run_id: string; status: string }>;
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
  };
}
