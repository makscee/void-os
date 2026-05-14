// React hook that bridges:
//   - Daemon WS frames (via FrameBus)              → reducer state
//   - assistant-ui's `useExternalStoreRuntime`     ← reducer state
//   - Composer "send" (onNew)                      → POST /chat/:id/message
//                                                    OR enqueue if running
//
// Composer is ALWAYS enabled (VOS-80 reframe). When a run is in flight we
// route sends into a per-chat local queue. On `run.end` (any status) we pop
// the queue head and POST it, kicking off the next run. ESC inside the
// composer fires POST /chat/:id/cancel (no-op on 409 "no_active_run").

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
  /** Surface a send-time error (e.g. 409 run_in_progress) to the parent.
   *  Receives the bound chatId at send-time + the thrown error. Best-effort:
   *  failures here must not poison the runtime. */
  onSendError?: (chatId: string, err: unknown) => void;
}

/** Marker prefix injected into queued bubble text so the renderer can
 *  surface a "↻ queued" badge + faded opacity. The actual text after the
 *  marker is the user's typed body. Kept here as a single-token sentinel to
 *  avoid leaking a richer ThreadMessageLike shape just for one visual cue. */
export const QUEUED_MARKER = "vos-queued";

const toThreadMessage = (m: ChatMessage): ThreadMessageLike => {
  if (m.role === "assistant" && m.parts && m.parts.length > 0) {
    const content = m.parts.map((p) => {
      if (p.kind === "text") {
        return { type: "text" as const, text: p.text };
      }
      // Tool part → assistant-ui's "tool-call" content shape. `result` is the
      // normalized string output; `args` is the input JSON object. Tool UIs
      // registered via makeAssistantToolUI dispatch on `toolName`.
      // `args` is widened from Record<string, unknown> to assistant-ui's
      // ReadonlyJSONObject — daemon input is JSON-derived so this is safe.
      return {
        type: "tool-call" as const,
        toolCallId: p.toolCallId,
        toolName: p.name,
        args: p.input,
        result: p.output,
        isError: p.isError,
      };
    }) as ThreadMessageLike["content"];
    return { id: m.id, role: m.role, content };
  }
  // Queued user bubbles get the marker prefixed so ChatRoot's TextPart can
  // strip it and render the badge.
  const text = m.queued ? `${QUEUED_MARKER}${m.text}` : m.text;
  return {
    id: m.id,
    role: m.role,
    content: [{ type: "text", text }],
  };
};

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

export interface ChatRuntimeHandle {
  runtime: ReturnType<typeof useExternalStoreRuntime<ThreadMessageLike>>;
  /** Cancel the active run for the bound chat. Returns true if the daemon
   *  reported a cancel; false if there was no active run (409). Errors bubble.
   *  Use this from an ESC keydown handler bound to the composer textarea. */
  cancel: () => Promise<boolean>;
  /** True while a run is streaming. Drives the ESC hint visibility. */
  isRunning: boolean;
}

export function useChatRuntime(deps: ChatRuntimeDeps): ChatRuntimeHandle {
  const [state, dispatch] = useReducer(
    chatReducer,
    deps.chatId,
    initialChatState,
  );

  // Track latest chatId in a ref so onNew (callback identity stable) sees it.
  const chatIdRef = useRef<string | null>(deps.chatId);
  // Track previous runState so we can detect transitions running → !running
  // and trigger the queue flush exactly once per terminal frame.
  const prevRunStateRef = useRef(state.runState);
  // Re-entrancy guard for flushQueue: when run.end arrives we POST the next
  // queued message; that POST kicks a fresh run.start frame which can race
  // with the flush logic. The ref prevents overlapping flushes.
  const flushingRef = useRef(false);

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

  // Queue flush on run.end (any terminal status — done, error, cancelled).
  // Detect by transition: prev runState === "running", new !== "running".
  useEffect(() => {
    const prev = prevRunStateRef.current;
    prevRunStateRef.current = state.runState;
    if (prev !== "running" || state.runState === "running") return;
    const chatId = chatIdRef.current;
    if (!chatId) return;
    if (flushingRef.current) return;
    const head = (state.queues[chatId] ?? [])[0];
    if (!head) return;

    flushingRef.current = true;
    // Optimistically promote queued bubble to a real optimistic user_send:
    // pop from queue, append as user_send so the bubble loses its "queued"
    // styling immediately. Reducer's reconcileUser will swap the temp id for
    // the canonical "user-<run_id>" when chat.message_user echoes.
    dispatch({ kind: "dequeue", chatId, id: head.id });
    const tempId = `user-temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dispatch({ kind: "user_send", text: head.text, tempId });

    deps.api.postMessage(chatId, head.text)
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[void-os] queue-flush postMessage failed", err);
        try { deps.onSendError?.(chatId, err); } catch { /* swallow */ }
      })
      .finally(() => {
        flushingRef.current = false;
      });
  }, [state.runState, state.queues, deps.api, deps.onSendError]);

  // Build assistant-ui-shaped messages — merge in queued items for the active
  // chat as synthetic user bubbles AT THE END (queued items always trail any
  // currently-streaming assistant reply).
  const messages = useMemo(() => {
    const base = state.messages.map(toThreadMessage);
    const cid = state.chatId;
    if (!cid) return base;
    const q = state.queues[cid];
    if (!q || q.length === 0) return base;
    const queuedThread: ThreadMessageLike[] = q.map((qm) => ({
      id: qm.id,
      role: "user" as const,
      content: [{ type: "text" as const, text: `${QUEUED_MARKER}${qm.text}` }],
    }));
    return base.concat(queuedThread);
  }, [state.messages, state.queues, state.chatId]);

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

      // If a run is streaming for this chat, enqueue instead of POSTing.
      // The flush effect will pop + POST on run.end.
      // Note: we read prevRunStateRef rather than state.runState directly so
      // multiple sends inside the same render aren't all dispatched as POSTs
      // when state hasn't yet committed.
      const runningNow = prevRunStateRef.current === "running";
      if (runningNow) {
        const qid = `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        dispatch({ kind: "enqueue", chatId, id: qid, text });
        return;
      }

      // Optimistic user bubble. Reconciled when daemon echoes chat.message_user.
      const tempId = `user-temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      dispatch({ kind: "user_send", text, tempId });

      try {
        await deps.api.postMessage(chatId, text);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[void-os] postMessage failed", err);
        try { deps.onSendError?.(chatId, err); } catch { /* swallow */ }
      }
    },
    [deps.api, deps.defaultAgent, deps.onChatIdMinted, deps.onSendError],
  );

  const cancel = useCallback(async () => {
    const chatId = chatIdRef.current;
    if (!chatId) return false;
    try {
      const r = await deps.api.cancel(chatId);
      if ("noActiveRun" in r && r.noActiveRun) return false;
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[void-os] cancel failed", err);
      try { deps.onSendError?.(chatId, err); } catch { /* swallow */ }
      return false;
    }
  }, [deps.api, deps.onSendError]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    // Composer is always enabled. We no longer gate isRunning/isDisabled on
    // runState — sends made during a run are enqueued, not blocked.
    isRunning: false,
    onNew,
    convertMessage: (m) => m,
  });

  return { runtime, cancel, isRunning: state.runState === "running" };
}

// Re-exported for tests.
export type { ChatState };
