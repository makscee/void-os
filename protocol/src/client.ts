import { HealthResp } from "./health.ts";
import { AgentsListResp } from "./agents.ts";
import { z } from "zod";

// Loose envelopes — daemon owns the source of truth. Tighten if/when needed.
const VaultFileResp = z.object({ path: z.string(), content: z.string(), sha256: z.string().optional(), size: z.number().optional() }).passthrough();
// Verified against daemon/src/api/vault.ts PUT /vault/file — returns {path, content, size, mtime}.
const VaultWriteResp = z.object({ path: z.string(), size: z.number().nonnegative(), mtime: z.number() }).passthrough();
// Verified against daemon/src/api/vault.ts GET /vault/list — returns {path, entries:[{name,type,size,mtime}]}.
const VaultListEntry = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().nonnegative(),
  mtime: z.number(),
});
const VaultListResp = z.object({ path: z.string(), entries: z.array(VaultListEntry) }).passthrough();
export type VaultFileResp = z.infer<typeof VaultFileResp>;
// Not re-exported: vault.ts owns the canonical `VaultWriteResp` / `VaultListResp`
// type names. These local aliases are the loose client-side envelopes and stay
// module-private so `export *` from index.ts does not collide (VOS-167).
type VaultWriteRespLocal = z.infer<typeof VaultWriteResp>;
type VaultListRespLocal = z.infer<typeof VaultListResp>;

// Verified against daemon/src/api/chats.ts POST /chats — returns {id, title, created_at}.
// Note: response key is `id` (not `chat_id`).
// `title` is nullable: daemon stub titler (used in fake-provider E2E) returns
// null until the real titler fills it in. See daemon/src/chat/repo.ts ChatRow.
const ChatCreateResp = z.object({
  id: z.string(),
  title: z.string().nullable(),
  created_at: z.number(),
}).passthrough();
// Verified against daemon/src/api/chat.ts POST /chat/:id/message — orchestrator returns {run_id, ...}.
const ChatSendResp = z.object({ run_id: z.string() }).passthrough();
// Verified against daemon/src/api/answer.ts POST /chat/:id/answer — returns {ok:true}.
const ChatAnswerResp = z.object({ ok: z.literal(true) }).passthrough();
// Verified against daemon/src/api/chat.ts POST /chat/:id/cancel — returns {run_id, status:"cancelled"}.
const ChatCancelResp = z.object({ run_id: z.string(), status: z.string() }).passthrough();
export type ChatCreateResp = z.infer<typeof ChatCreateResp>;
export type ChatSendResp = z.infer<typeof ChatSendResp>;
export type ChatAnswerResp = z.infer<typeof ChatAnswerResp>;
export type ChatCancelResp = z.infer<typeof ChatCancelResp>;

export class ApiError extends Error {
  // `override`: daemon/tsconfig.json sets noImplicitOverride; these shadow
  // members of the base Error class and must be marked explicitly (VOS-167).
  override readonly name = "ApiError" as const;
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}
export class ServerError extends Error {
  override readonly name = "ServerError" as const;
  constructor(public readonly status: number, public readonly body: string) {
    super(`server error ${status}: ${body.slice(0, 200)}`);
  }
}
export class UnreachableError extends Error {
  override readonly name = "UnreachableError" as const;
  constructor(public override readonly cause: unknown) {
    super(`daemon unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export interface ClientOpts {
  base: string;
  token: string;
  fetch?: typeof fetch;
}

export interface Client {
  health(): Promise<HealthResp>;
  agents: { list(): Promise<AgentsListResp> };
  vault: {
    read(path: string): Promise<VaultFileResp>;
    write(path: string, content: string): Promise<VaultWriteRespLocal>;
    list(path?: string, opts?: { depth?: number }): Promise<VaultListRespLocal>;
  };
  chat: {
    create(opts?: { agent?: string }): Promise<ChatCreateResp>;
    send(chatId: string, text: string): Promise<ChatSendResp>;
    answer(chatId: string, toolUseId: string, answer: string): Promise<ChatAnswerResp>;
    cancel(chatId: string): Promise<ChatCancelResp>;
    stream(chatId: string): AsyncIterable<unknown>;
  };
}

export function makeClient(opts: ClientOpts): Client {
  const f = opts.fetch ?? fetch;
  const base = opts.base.replace(/\/$/, "");

  async function call<T extends z.ZodTypeAny>(
    pathname: string,
    init: RequestInit,
    schema: T,
  ): Promise<z.infer<T>> {
    const url = `${base}${pathname}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${opts.token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    let res: Response;
    try {
      res = await f(url, { ...init, headers });
    } catch (e) {
      throw new UnreachableError(e);
    }
    if (res.status >= 500) {
      throw new ServerError(res.status, await res.text());
    }
    if (res.status >= 400) {
      let body: any = null;
      try { body = await res.json(); } catch { body = { error: "E_UNKNOWN", message: await res.text() }; }
      throw new ApiError(String(body.error ?? "E_UNKNOWN"), String(body.message ?? ""), res.status);
    }
    return schema.parse(await res.json());
  }

  async function* sseFrames(pathname: string): AsyncIterable<unknown> {
    const url = `${base}${pathname}`;
    const headers = new Headers({ Authorization: `Bearer ${opts.token}` });
    let res: Response;
    try {
      res = await f(url, { headers });
    } catch (e) {
      throw new UnreachableError(e);
    }
    if (!res.ok || !res.body) {
      throw new ApiError("E_STREAM", `stream failed (status ${res.status})`, res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        if (!json) continue;
        try { yield JSON.parse(json); } catch { /* skip malformed */ }
      }
    }
  }

  return {
    health: () => call("/health", { method: "GET" }, HealthResp),
    agents: { list: () => call("/agents", { method: "GET" }, AgentsListResp) },
    vault: {
      read: (path) => call(`/vault/file?path=${encodeURIComponent(path)}`, { method: "GET" }, VaultFileResp),
      write: (path, content) =>
        call(`/vault/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ path, content }) }, VaultWriteResp),
      list: (path, lopts) => {
        const params = new URLSearchParams();
        if (path) params.set("path", path);
        if (lopts?.depth != null) params.set("depth", String(lopts.depth));
        const qs = params.toString();
        return call(`/vault/list${qs ? `?${qs}` : ""}`, { method: "GET" }, VaultListResp);
      },
    },
    chat: {
      create: (copts) =>
        call(
          "/chats",
          { method: "POST", body: JSON.stringify(copts?.agent ? { agent: copts.agent } : {}) },
          ChatCreateResp,
        ),
      send: (chatId, text) =>
        call(
          `/chat/${encodeURIComponent(chatId)}/message`,
          { method: "POST", body: JSON.stringify({ text }) },
          ChatSendResp,
        ),
      answer: (chatId, toolUseId, answer) =>
        call(
          `/chat/${encodeURIComponent(chatId)}/answer`,
          { method: "POST", body: JSON.stringify({ tool_use_id: toolUseId, answer }) },
          ChatAnswerResp,
        ),
      cancel: (chatId) =>
        call(
          `/chat/${encodeURIComponent(chatId)}/cancel`,
          { method: "POST", body: "{}" },
          ChatCancelResp,
        ),
      stream: (chatId) => sseFrames(`/chat/${encodeURIComponent(chatId)}/stream`),
    },
  };
}
