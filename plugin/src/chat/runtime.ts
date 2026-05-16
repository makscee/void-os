// React hook that bridges:
//   - Daemon WS frames (via FrameBus)              → reducer (overlay/state-only)
//   - Daemon HTTP GET /chat/:id/messages refetch    → reducer (replaces state.messages)
//   - assistant-ui's `useExternalStoreRuntime`     ← derived ThreadMessageLike[]
//   - Composer "send" (onNew)                      → POST /chat/:id/message
//                                                    OR enqueue if running
//
// VOS-80 part 2: daemon DB is the canonical source of truth. WS frames are
// invalidation signals. We refetch GET /chat/:id/messages after every
// run.end (debounced) and replace `state.messages`.
//
// Live tokens & tool events stream into the reducer's `liveTokens` +
// `liveToolEvents` *overlay* state, NOT into `messages`. The runtime here
// builds a synthetic in-flight assistant ChatMessage from the overlay and
// appends it to the renderable list while `runState === "running"`. On
// run.end the overlay is cleared by the reducer and the refetched messages
// take over.
//
// Composer is ALWAYS enabled. When a run is in flight, sends route into a
// per-chat local queue. On run.end (any status) we pop + POST. ESC fires
// POST /chat/:id/cancel (no-op on 409).

import { useEffect, useMemo, useReducer, useRef, useCallback, type Dispatch } from "react";
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
  type LocalAction,
  type ToolPart,
} from "./reducer";

export interface ChatRuntimeDeps {
  bus: FrameBus;
  api: ChatApi;
  chatId: string | null;
  onChatIdMinted?: (id: string) => void | Promise<void>;
  defaultAgent?: string;
  onSendError?: (chatId: string, err: unknown) => void;
  /** Receives transient toast strings ("question already resolved", buttons-only
   *  inert hint, etc.). ChatRoot wires this to its in-chat toast surface. */
  onComposerToast?: (text: string) => void;
}

export const QUEUED_MARKER = "vos-queued";
export const STOPPED_MARKER = "vos-stopped";
/** Inline marker for a synthetic assistant message that displays the
 *  "Claude didn't respond. Try again." notice after a timeout/error run.end.
 *  Distinct from STOPPED_MARKER (user-initiated cancel) — different copy,
 *  different color. See ChatRoot MarkdownText for rendering. */
export const TIMEOUT_MARKER = "vos-timeout";
export const ERROR_MARKER = "vos-error";

/** Minimum interval between getMessages refetches (run.end debounce).
 *  Per the VOS-80 part-2 plan: ≥200ms. We use 250ms as a slightly safer
 *  default for rapid run.start→run.end cycles. */
const REFETCH_DEBOUNCE_MS = 250;

const toThreadMessage = (m: ChatMessage): ThreadMessageLike => {
  if (m.role === "assistant" && m.cancelled && (!m.parts || m.parts.length === 0)) {
    return {
      id: m.id,
      role: "assistant",
      content: [{ type: "text", text: STOPPED_MARKER }],
    };
  }
  if (m.role === "assistant" && m.parts && m.parts.length > 0) {
    const content = m.parts.map((p) => {
      if (p.kind === "text") {
        return { type: "text" as const, text: p.text };
      }
      return {
        type: "tool-call" as const,
        toolCallId: p.toolCallId,
        toolName: p.name,
        args: p.input,
        result: p.output,
        isError: p.isError,
      };
    }) as ThreadMessageLike["content"];
    if (m.cancelled) {
      (content as Array<{ type: "text"; text: string }>).push({
        type: "text",
        text: STOPPED_MARKER,
      });
    }
    return { id: m.id, role: m.role, content };
  }
  const text = m.queued ? `${QUEUED_MARKER}${m.text}` : m.text;
  return {
    id: m.id,
    role: m.role,
    content: [{ type: "text", text }],
  };
};

/** Build the in-flight assistant overlay message from live buffers.
 *  Returns null if there's nothing to overlay. The overlay sits AFTER the
 *  refetched server messages and reflects the current run only.
 *
 *  When `cancelled` is true (e.g. after local_cancel before run.end arrives),
 *  the overlay carries the cancelled flag so the renderer appends a
 *  STOPPED_MARKER text part — visual confirmation that ESC took effect even
 *  before the refetch lands. */
function buildOverlay(
  runId: string | null,
  liveTokens: string,
  liveToolEvents: ToolPart[],
  cancelled: boolean,
  toolsFirst: boolean,
): ChatMessage | null {
  if (!runId) return null;
  if (!liveTokens && liveToolEvents.length === 0) return null;
  // Arrival-order ordering: when tools landed BEFORE any text streamed
  // (e.g. ask_user fires a tool_use first, then text "chose red" arrives
  // post-answer), keep tools at their original index positions so the
  // tool part doesn't shift from index 0 → index 1 when text arrives.
  // Otherwise (text first, then tools) the historic [text, ...tools]
  // order is correct and stable.
  //
  // Stability matters because assistant-ui's MessagePart is keyed by
  // partIndex (see MessagePartsGrouped.js + ExternalThread.js part lookups
  // via tapClientLookup-by-index). A part shifting index between renders
  // mid-tool-call surfaces as `tapClientLookup: Index N out of bounds
  // (length: N)` when the rendered tool UI's part lookup races with the
  // store's part-list update. VOS-90 T8.
  const parts: ChatMessage["parts"] = [];
  if (toolsFirst) {
    for (const t of liveToolEvents) parts.push(t);
    if (liveTokens) parts.push({ kind: "text", text: liveTokens });
  } else {
    if (liveTokens) parts.push({ kind: "text", text: liveTokens });
    for (const t of liveToolEvents) parts.push(t);
  }
  return {
    id: runId,
    role: "assistant",
    text: liveTokens,
    complete: cancelled,
    cancelled: cancelled || undefined,
    parts,
  };
}

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
  cancel: () => Promise<boolean>;
  isRunning: boolean;
  send: (text: string) => Promise<void>;
  /** Mirror of reducer state.pendingAskUser, exposed for ChatRoot composer-mode
   *  branching. */
  pendingAskUser: ChatState["pendingAskUser"];
  /** Dispatcher exposed for AskUserTool's 409 path (option-button click
   *  loses race with another tab). Clears pendingAskUser so the banner
   *  detaches without waiting for the daemon's tool_result echo. */
  notifyAnswer409: () => void;
  /** Full reducer state — exposed so ChatRoot can thread it into ChildTaskContext
   *  for AskAgentTool rendering (VOS-91 T16). */
  chatState: ChatState;
  /** Reducer dispatch — exposed so ChatRoot can thread it into ChildTaskContext
   *  for child_toggle actions from AskAgentTool (VOS-91 T16). */
  dispatch: Dispatch<LocalAction>;
}

export function useChatRuntime(deps: ChatRuntimeDeps): ChatRuntimeHandle {
  const [state, dispatch] = useReducer(
    chatReducer,
    deps.chatId,
    initialChatState,
  );

  const chatIdRef = useRef<string | null>(deps.chatId);
  const prevRunStateRef = useRef(state.runState);
  const flushingRef = useRef(false);
  // Refetch debounce — last refetch wall-clock timestamp per chat.
  const lastRefetchAtRef = useRef<Record<string, number>>({});
  // In-flight refetch guard (per chat) so concurrent run.end frames don't
  // spawn duplicate GETs.
  const refetchingRef = useRef<Record<string, boolean>>({});
  // Track stoppedRunId at refetch time (consumed by reducer to tag cancelled).
  const pendingStoppedRunIdRef = useRef<string | null>(state.pendingStoppedRunId);
  useEffect(() => {
    pendingStoppedRunIdRef.current = state.pendingStoppedRunId;
  }, [state.pendingStoppedRunId]);

  /** Refetch GET /chat/:id/messages with debounce + concurrency guard.
   *  On success dispatches `refetched`. On failure we keep last-known-good
   *  `messages` and log — the spec forbids clearing on error. */
  const refetchMessages = useCallback(
    async (chatId: string, opts: { force?: boolean } = {}) => {
      if (!chatId) return;
      const now = Date.now();
      const last = lastRefetchAtRef.current[chatId] ?? 0;
      if (!opts.force && now - last < REFETCH_DEBOUNCE_MS) return;
      if (refetchingRef.current[chatId]) return;
      lastRefetchAtRef.current[chatId] = now;
      refetchingRef.current[chatId] = true;
      try {
        const rows = await deps.api.getMessages(chatId);
        if (chatIdRef.current !== chatId) return; // stale
        const stoppedRunId = pendingStoppedRunIdRef.current ?? undefined;
        dispatch({
          kind: "refetched",
          chatId,
          messages: rows,
          stoppedRunId,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[void-os] refetch /messages failed", err);
        // Last-known-good preserved by reducer no-op.
      } finally {
        refetchingRef.current[chatId] = false;
      }
    },
    [deps.api],
  );

  // Chat switch: bind reducer + refetch /messages.
  useEffect(() => {
    chatIdRef.current = deps.chatId;
    if (!deps.chatId) return;
    dispatch({ kind: "set_chat", chatId: deps.chatId });
    void refetchMessages(deps.chatId, { force: true });
  }, [deps.chatId, refetchMessages]);

  // Subscribe to bus once. Frame dispatch + run.end refetch trigger live
  // here so we catch terminal frames even when multiple frames batch within
  // a single React act() (state transitions can collapse — e.g. a quick
  // start→token→end sequence may never expose runState="running" to the
  // commit-phase effect below, but the bus subscriber sees every frame).
  useEffect(() => {
    const off = deps.bus.on((frame) => {
      dispatch({ kind: "frame", frame });
      // Direct refetch trigger on terminal frames — independent of
      // runState transition detection.
      if (frame.type === "run.end" || frame.type === "run.error") {
        const chatId = chatIdRef.current;
        if (chatId) void refetchMessages(chatId, { force: true });
      }
    });
    return off;
  }, [deps.bus, refetchMessages]);

  // Queue flush on running→!running transition. Distinct from the refetch
  // trigger above because queue logic depends on committed reducer state
  // (state.queues), not raw frames.
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

  // Build assistant-ui-shaped messages — server `messages` + live overlay
  // (assistant turn in flight) + queued user bubbles at the tail.
  const messages = useMemo(() => {
    const base = state.messages.map(toThreadMessage);
    const cid = state.chatId;
    // Live overlay rendering conditions:
    //   - running: build from activeRunId
    //   - idle + pendingStoppedRunId armed: build the stopped overlay
    //     (between local_cancel and the refetch landing) keyed on the
    //     pending run id, so the partial bubble + (stopped) badge stay
    //     visible until canonical state arrives.
    if (state.runState === "running") {
      const overlay = buildOverlay(
        state.activeRunId,
        state.liveTokens,
        state.liveToolEvents,
        false,
        state.liveToolsFirst,
      );
      if (overlay) base.push(toThreadMessage(overlay));
    } else if (state.pendingStoppedRunId) {
      const overlay = buildOverlay(
        state.pendingStoppedRunId,
        state.liveTokens,
        state.liveToolEvents,
        true,
        state.liveToolsFirst,
      );
      if (overlay) base.push(toThreadMessage(overlay));
    }
    // Inline error notice (timeout / generic). Appended AFTER overlay so it
    // sits where the missing assistant reply would have been. Cleared by
    // run.start / set_chat / user_send / local_cancel via the reducer.
    if (state.errorNotice) {
      const marker =
        state.errorNotice.kind === "timeout" ? TIMEOUT_MARKER : ERROR_MARKER;
      base.push({
        id: `notice-${state.errorNotice.runId}`,
        role: "assistant",
        content: [{ type: "text", text: marker }],
      });
    }
    if (!cid) return base;
    const q = state.queues[cid];
    if (!q || q.length === 0) return base;
    const queuedThread: ThreadMessageLike[] = q.map((qm) => ({
      id: qm.id,
      role: "user" as const,
      content: [{ type: "text" as const, text: `${QUEUED_MARKER}${qm.text}` }],
    }));
    return base.concat(queuedThread);
  }, [
    state.messages,
    state.runState,
    state.activeRunId,
    state.liveTokens,
    state.liveToolEvents,
    state.liveToolsFirst,
    state.pendingStoppedRunId,
    state.errorNotice,
    state.queues,
    state.chatId,
  ]);

  const sendText = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text) return;

      let chatId = chatIdRef.current;
      if (!chatId) {
        const created = await deps.api.createChat(deps.defaultAgent);
        chatId = created.id;
        chatIdRef.current = chatId;
        dispatch({ kind: "set_chat", chatId });
        await deps.onChatIdMinted?.(chatId);
      }

      // ask_user routing. Read directly from `state.pendingAskUser` — the
      // callback's dep array includes it, so the latest reducer snapshot is
      // captured on every commit. React's commit phase has already flushed
      // before any user-driven send call lands here.
      const pending = state.pendingAskUser;
      if (pending) {
        if (pending.options && pending.options.length > 0) {
          // Buttons-only mode — Send is hidden but Enter can still fire. Inert.
          deps.onComposerToast?.("Pick one of the options above to continue.");
          return;
        }
        // Free-form answer mode.
        try {
          const r = await deps.api.answer(chatId, pending.toolUseId, text);
          if (!r.ok) {
            if (r.status === 409) {
              dispatch({ kind: "local_answer_409" });
              deps.onComposerToast?.("Question already resolved.");
              return;
            }
            deps.onComposerToast?.(`Couldn't send (${r.status}).`);
            return;
          }
          // Success: composer-clearing is the caller's job (mirrors
          // QueueSendButton). Reducer clears pendingAskUser when the matching
          // tool_result frame lands.
          return;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[void-os] /answer failed", err);
          deps.onComposerToast?.("Couldn't send — try again.");
          return;
        }
      }

      const runningNow = prevRunStateRef.current === "running";
      if (runningNow) {
        const qid = `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        dispatch({ kind: "enqueue", chatId, id: qid, text });
        return;
      }

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
    [deps, state.pendingAskUser],
  );

  const onNew = useCallback(
    async (msg: AppendMessage) => {
      await sendText(extractText(msg));
    },
    [sendText],
  );

  const cancel = useCallback(async () => {
    const chatId = chatIdRef.current;
    if (!chatId) return false;
    try {
      const r = await deps.api.cancel(chatId);
      if ("noActiveRun" in r && r.noActiveRun) return false;
      dispatch({ kind: "local_cancel" });
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[void-os] cancel failed", err);
      try { deps.onSendError?.(chatId, err); } catch { /* swallow */ }
      return false;
    }
  }, [deps.api, deps.onSendError]);

  const isRunning = state.runState === "running";

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning,
    onNew,
    convertMessage: (m) => m,
  });

  const notifyAnswer409 = useCallback(() => {
    dispatch({ kind: "local_answer_409" });
  }, []);

  return {
    runtime,
    cancel,
    isRunning,
    send: sendText,
    pendingAskUser: state.pendingAskUser,
    notifyAnswer409,
    chatState: state,
    dispatch,
  };
}

// Re-exported for tests.
export type { ChatState };
