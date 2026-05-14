// Pure reducer for the chat thread state. Independent of React + assistant-ui
// so it can be unit-tested in isolation (see test/chat-reducer.test.ts).
//
// Daemon wire shape (VOS-79):
//   chat.message_user  {chat_id, run_id, text}
//   run.start          {chat_id, run_id, agent}
//   chat.token         {chat_id, run_id, delta}    ← assistant streaming
//   chat.completion    {chat_id, run_id}
//   run.end            {chat_id, run_id, status}   ← terminal
//   run.error          {chat_id, run_id, error}    ← terminal
//
// Dedupe key per the plan is "msg_id". The daemon does not (yet) emit a
// per-assistant-message id; one assistant message per run, keyed by `run_id`.
// We use `run_id` as the stable id so re-subscribing mid-run is idempotent.

import type { DaemonFrame } from "./bus";

export type Role = "user" | "assistant";

export interface ChatMessage {
  /** Stable id used for dedupe. For assistant rows = run_id. For user rows
   *  we mint a synthetic id ("user-<run_id>") so reconciliation is trivial. */
  id: string;
  role: Role;
  text: string;
  /** assistant message becomes complete on chat.completion / run.end. */
  complete: boolean;
}

export type RunState = "idle" | "running" | "error";

export interface ChatState {
  /** Chat id this state is bound to. Frames for other chats are ignored. */
  chatId: string | null;
  messages: ChatMessage[];
  runState: RunState;
  /** run_id of the currently-streaming assistant message, if any. */
  activeRunId: string | null;
}

export const initialChatState = (chatId: string | null = null): ChatState => ({
  chatId,
  messages: [],
  runState: "idle",
  activeRunId: null,
});

/** Local optimistic action: user has just submitted via the composer. We
 *  append the user bubble immediately so the UI is responsive; the daemon's
 *  echoing chat.message_user frame is then deduped by id. */
export type LocalAction =
  | { kind: "set_chat"; chatId: string }
  | { kind: "user_send"; text: string; tempId: string }
  | { kind: "frame"; frame: DaemonFrame };

function upsertAssistantDelta(
  msgs: ChatMessage[],
  runId: string,
  delta: string,
): ChatMessage[] {
  const idx = msgs.findIndex((m) => m.id === runId);
  if (idx === -1) {
    return [...msgs, { id: runId, role: "assistant", text: delta, complete: false }];
  }
  const next = msgs.slice();
  next[idx] = { ...next[idx], text: next[idx].text + delta };
  return next;
}

function markAssistantComplete(msgs: ChatMessage[], runId: string): ChatMessage[] {
  const idx = msgs.findIndex((m) => m.id === runId);
  if (idx === -1) return msgs;
  if (msgs[idx].complete) return msgs;
  const next = msgs.slice();
  next[idx] = { ...next[idx], complete: true };
  return next;
}

/** Replace the optimistic user bubble (id starting with "user-temp-") with
 *  the canonical id derived from run_id, OR append if not present (e.g.
 *  reconnecting mid-run where we never optimistically appended). Idempotent. */
function reconcileUser(
  msgs: ChatMessage[],
  runId: string,
  text: string,
): ChatMessage[] {
  const canonicalId = `user-${runId}`;
  if (msgs.some((m) => m.id === canonicalId)) return msgs;
  // Try to swap a leading optimistic user bubble whose text matches.
  const idx = msgs.findIndex(
    (m) => m.role === "user" && m.id.startsWith("user-temp-") && m.text === text,
  );
  if (idx !== -1) {
    const next = msgs.slice();
    next[idx] = { ...next[idx], id: canonicalId };
    return next;
  }
  return [...msgs, { id: canonicalId, role: "user", text, complete: true }];
}

export function chatReducer(state: ChatState, action: LocalAction): ChatState {
  switch (action.kind) {
    case "set_chat": {
      if (state.chatId === action.chatId) return state;
      return initialChatState(action.chatId);
    }
    case "user_send": {
      // Optimistic append. Will be reconciled when chat.message_user echoes.
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: action.tempId, role: "user", text: action.text, complete: true },
        ],
      };
    }
    case "frame": {
      const f = action.frame;
      const fChat = typeof f.chat_id === "string" ? f.chat_id : null;
      // Drop frames not for our chat once a chat is bound.
      if (state.chatId && fChat && fChat !== state.chatId) return state;
      const runId = typeof f.run_id === "string" ? f.run_id : null;

      switch (f.type) {
        case "run.start": {
          if (!runId) return state;
          return { ...state, runState: "running", activeRunId: runId };
        }
        case "chat.message_user": {
          if (!runId) return state;
          const text = typeof f.text === "string" ? f.text : "";
          return { ...state, messages: reconcileUser(state.messages, runId, text) };
        }
        case "chat.token": {
          if (!runId) return state;
          const delta = typeof f.delta === "string" ? f.delta : "";
          if (!delta) return state;
          return { ...state, messages: upsertAssistantDelta(state.messages, runId, delta) };
        }
        case "chat.completion": {
          if (!runId) return state;
          return { ...state, messages: markAssistantComplete(state.messages, runId) };
        }
        case "run.end": {
          if (!runId) return state;
          const status = typeof f.status === "string" ? f.status : "done";
          return {
            ...state,
            messages: markAssistantComplete(state.messages, runId),
            runState: status === "error" ? "error" : "idle",
            activeRunId:
              state.activeRunId === runId ? null : state.activeRunId,
          };
        }
        case "run.error": {
          if (!runId) return state;
          return {
            ...state,
            messages: markAssistantComplete(state.messages, runId),
            runState: "error",
            activeRunId:
              state.activeRunId === runId ? null : state.activeRunId,
          };
        }
        default:
          return state;
      }
    }
  }
}
