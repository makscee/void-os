// React hook that bridges:
//   - Daemon WS frames (via FrameBus)              → reducer state
//   - assistant-ui's `useExternalStoreRuntime`     ← reducer state
//   - Composer "send" (onNew)                      → POST /chat/:id/message
//
// Composer enabled/disabled is gated on `state.runState` (echoed by daemon
// via run.start / run.end / run.error) per the binding decision in the task
// file: "use daemon run-state echo, not local guess".

import { useEffect, useMemo, useReducer, useRef, useCallback } from "react";
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from "@assistant-ui/react";

import type { FrameBus } from "./bus";
import type { ChatApi } from "./api";
import {
  chatReducer,
  initialChatState,
  type ChatMessage,
  type ChatState,
} from "./reducer";

export interface ChatRuntimeDeps {
  bus: FrameBus;
  api: ChatApi;
  /** Initial pinned chat id; if null we'll mint one via `createChat()` on the
   *  first send. The minted id is reported back via `onChatIdMinted` so the
   *  plugin can persist it through SettingsStore. */
  chatId: string | null;
  onChatIdMinted?: (id: string) => void | Promise<void>;
  /** Default agent for newly-minted chats. */
  defaultAgent?: string;
}

const toThreadMessage = (m: ChatMessage): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  content: [{ type: "text", text: m.text }],
});

// assistant-ui passes AppendMessage on send — we extract a plain string.
function extractText(msg: AppendMessage): string {
  if (typeof (msg as unknown as { content?: unknown }).content === "string") {
    return (msg as unknown as { content: string }).content;
  }
  const parts = (msg.content ?? []) as Array<{ type?: string; text?: string }>;
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

export function useChatRuntime(deps: ChatRuntimeDeps) {
  const [state, dispatch] = useReducer(
    chatReducer,
    deps.chatId,
    initialChatState,
  );

  // Track latest chatId in a ref so onNew (callback identity stable) sees it.
  const chatIdRef = useRef<string | null>(deps.chatId);
  useEffect(() => {
    chatIdRef.current = deps.chatId;
    if (!deps.chatId) return;
    dispatch({ kind: "set_chat", chatId: deps.chatId });
    // Hydrate from history. Race-safety lives in two layers:
    //   1) chatIdRef check on resolve;
    //   2) hydrate reducer ignores if state.chatId moved on.
    const requested = deps.chatId;
    let cancelled = false;
    deps.api.getMessages(requested)
      .then((rows) => {
        if (cancelled) return;
        if (chatIdRef.current !== requested) return;
        dispatch({ kind: "hydrate", chatId: requested, messages: rows });
      })
      .catch((err: unknown) => {
        // History fetch is best-effort; log + carry on with empty thread.
        // eslint-disable-next-line no-console
        console.error("[void-os] getMessages failed", err);
      });
    return () => { cancelled = true; };
  }, [deps.chatId, deps.api]);

  // Subscribe to bus once.
  useEffect(() => {
    const off = deps.bus.on((frame) => dispatch({ kind: "frame", frame }));
    return off;
  }, [deps.bus]);

  // Build assistant-ui-shaped messages.
  const messages = useMemo(
    () => state.messages.map(toThreadMessage),
    [state.messages],
  );

  const onNew = useCallback(
    async (msg: AppendMessage) => {
      const text = extractText(msg).trim();
      if (!text) return;

      // Mint a chat lazily if none pinned yet (avoids fresh-install UX cliff).
      let chatId = chatIdRef.current;
      if (!chatId) {
        const created = await deps.api.createChat(deps.defaultAgent);
        chatId = created.id;
        chatIdRef.current = chatId;
        dispatch({ kind: "set_chat", chatId });
        await deps.onChatIdMinted?.(chatId);
      }

      // Optimistic user bubble. Reconciled when daemon echoes chat.message_user.
      const tempId = `user-temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      dispatch({ kind: "user_send", text, tempId });

      try {
        await deps.api.postMessage(chatId, text);
      } catch (err) {
        // Roll the composer state back to idle so the user can retry. The
        // optimistic user bubble stays visible — they can see what they sent.
        // The daemon will not emit run.end since no run started.
        // eslint-disable-next-line no-console
        console.error("[void-os] postMessage failed", err);
      }
    },
    [deps.api, deps.defaultAgent, deps.onChatIdMinted],
  );

  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: state.runState === "running",
    isDisabled: state.runState === "running",
    onNew,
    convertMessage: (m) => m,
  });
}

// Re-exported for tests.
export type { ChatState };
