/**
 * Titler — Haiku-driven chat-title generator.
 *
 * Fires once per chat, on the first assistant turn (caller decides when).
 * Idempotent: no-ops if the chat already has a title.
 *
 * Wired up in T8 (orchestrator); for now it accepts its repo via DI so it can
 * land before chatRepo is committed by the parallel T2 subagent.
 *
 * Errors never throw out of `title()` — they emit `chat.title_failed` instead,
 * so the caller (the run pipeline) does not crash if Haiku is rate-limited.
 */

/** Minimal contract this module needs from `chatRepo` (T2). */
export interface ChatRepoLike {
  get(id: string): { id: string; title: string | null; session_id: string | null } | null;
  /** Returns true iff the row was updated (title was null before). */
  setTitle(id: string, title: string): boolean;
}

/** Minimal contract from `session-replay` (separate module). */
export interface SessionReplayLike {
  walk(chatId: string): ReadonlyArray<{ role: string; content: unknown }>;
}

/** Minimal contract from `@anthropic-ai/sdk` so tests can stub it. */
export interface AnthropicLike {
  messages: {
    create: (args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
  };
}

export interface TitlerDeps {
  repo: ChatRepoLike;
  sdk: AnthropicLike;
  replay: SessionReplayLike;
  emit: (type: string, payload: Record<string, unknown>) => void;
}

export interface Titler {
  title(chatId: string): Promise<void>;
}

/** Haiku 4.5 — cheap + fast, plenty for a 3-7 word title. */
export const TITLER_MODEL = "claude-haiku-4-5-20251001";

/** Last N turns to pass as context. Plenty of signal, keeps token cost flat. */
const TAIL_WINDOW = 10;

const SYSTEM_PROMPT =
  "Generate a 3-7 word title summarizing this chat. Reply with the title only, no quotes or punctuation.";

/** Strip wrapping quotes/whitespace and trailing punctuation. */
function cleanTitle(raw: string): string {
  let t = raw.trim();
  // Strip matching wrapping quotes (straight + curly).
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["`", "`"],
  ];
  for (const [open, close] of quotePairs) {
    if (t.startsWith(open) && t.endsWith(close) && t.length >= 2) {
      t = t.slice(open.length, t.length - close.length).trim();
      break;
    }
  }
  // Strip trailing punctuation.
  t = t.replace(/[.!?,;:]+$/u, "").trim();
  return t;
}

function extractText(res: { content?: Array<{ type: string; text?: string }> }): string {
  const blocks = res.content ?? [];
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
}

export function makeTitler({ repo, sdk, replay, emit }: TitlerDeps): Titler {
  return {
    async title(chatId: string): Promise<void> {
      const row = repo.get(chatId);
      // Guard: chat must exist, have a session (i.e. at least one turn), and no title yet.
      if (!row) return;
      if (row.title !== null) return;
      if (row.session_id === null) return;

      const tail = replay.walk(chatId).slice(-TAIL_WINDOW);
      try {
        const res = await sdk.messages.create({
          model: TITLER_MODEL,
          max_tokens: 30,
          system: SYSTEM_PROMPT,
          messages: tail.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content:
              typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          })),
        });
        const text = cleanTitle(extractText(res));
        if (!text) throw new Error("titler: empty SDK response");
        const ok = repo.setTitle(chatId, text);
        if (ok) emit("chat.title", { chat_id: chatId, title: text });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit("chat.title_failed", { chat_id: chatId, error: msg });
      }
    },
  };
}
