// Pure reducer for the chat thread state. Independent of React + assistant-ui
// so it can be unit-tested in isolation (see test/chat-reducer.test.ts).
//
// Daemon wire shape (VOS-79 + S4 tool frames):
//   chat.message_user  {chat_id, run_id, text}
//   run.start          {chat_id, run_id, agent}
//   chat.token         {chat_id, run_id, delta}             ← assistant streaming
//   chat.tool_use      {chat_id, run_id, tool_call_id, name, input}
//   chat.tool_result   {chat_id, run_id, tool_call_id, output, is_error}
//   chat.completion    {chat_id, run_id}
//   run.end            {chat_id, run_id, status}            ← terminal
//   run.error          {chat_id, run_id, error}             ← terminal
//
// Dedupe key per the plan is "msg_id". The daemon does not (yet) emit a
// per-assistant-message id; one assistant message per run, keyed by `run_id`.
// We use `run_id` as the stable id so re-subscribing mid-run is idempotent.

import type { DaemonFrame } from "./bus";

export type Role = "user" | "assistant";

/** Inline parts on an assistant message. The leading text from chat.token
 *  deltas lives in `ChatMessage.text` for back-compat with S1/S2/S3 tests
 *  and is mirrored as the first TextPart in `parts`. Tool-call parts are
 *  appended in arrival order (preserves daemon's intra-turn ordering). */
export type TextPart = { kind: "text"; text: string };
export type ToolPart = {
  kind: "tool";
  toolCallId: string;
  name: string;
  /** JSON-able object as emitted by the daemon. */
  input: Record<string, unknown>;
  /** Normalized string output once tool_result lands. `undefined` while running. */
  output?: string;
  /** True when daemon flagged the tool result as an error. Defaults to false. */
  isError: boolean;
};
export type AssistantPart = TextPart | ToolPart;

export interface ChatMessage {
  /** Stable id used for dedupe. For assistant rows = run_id. For user rows
   *  we mint a synthetic id ("user-<run_id>") so reconciliation is trivial. */
  id: string;
  role: Role;
  /** Concatenated assistant text (chat.token deltas). For user rows = body. */
  text: string;
  /** assistant message becomes complete on chat.completion / run.end. */
  complete: boolean;
  /** True when this assistant turn was terminated via cancel
   *  (run.end{status:"cancelled"}). UI surfaces a "(stopped)" badge.
   *  Partial text streamed so far is preserved. Undefined / false on
   *  normal done/error completions. */
  cancelled?: boolean;
  /** Assistant content parts in arrival order. Undefined for plain user rows. */
  parts?: AssistantPart[];
  /** Marker for synthetic "queued" user bubbles (typed during a streaming
   *  run, awaiting flush). Renders with reduced opacity + a "↻ queued" badge.
   *  Never set on real (run-bound) user messages. */
  queued?: boolean;
}

export type RunState = "idle" | "running" | "error";

/** A user message that was typed while a run was streaming. Held locally until
 *  the active run ends, then flushed FIFO into POST /chat/:id/message. */
export interface QueuedMessage {
  /** Stable id used by the UI to render the queued bubble. Mint with a
   *  "queued-" prefix so it never collides with optimistic user_send temp ids
   *  (which start with "user-temp-") or canonical "user-<run_id>" ids. */
  id: string;
  text: string;
}

/** Replay items returned by GET /chat/:id/messages. Heterogeneous: text turns
 *  (user/assistant) plus tool_use/tool_result entries. Tool entries attach to
 *  the nearest preceding assistant message in the same turn. */
export type ReplayMessage =
  | { role: "user" | "assistant"; content: string; ts?: number }
  | {
      role: "tool_use";
      tool_call_id: string;
      name: string;
      input: Record<string, unknown>;
      ts?: number;
    }
  | {
      role: "tool_result";
      tool_call_id: string;
      output: string | Array<{ type?: string; text?: string }>;
      is_error?: boolean;
      ts?: number;
    };

export interface ChatState {
  /** Chat id this state is bound to. Frames for other chats are ignored. */
  chatId: string | null;
  messages: ChatMessage[];
  runState: RunState;
  /** run_id of the currently-streaming assistant message, if any. */
  activeRunId: string | null;
  /** Per-chat send queue (user typed while run was streaming). Persists across
   *  set_chat so queued messages survive chat switches. The runtime renders
   *  queued items for the active chat as faded "↻ queued" bubbles, and on
   *  run.end pops the head + dispatches POST. */
  queues: Record<string, QueuedMessage[]>;
}

export const initialChatState = (chatId: string | null = null): ChatState => ({
  chatId,
  messages: [],
  runState: "idle",
  activeRunId: null,
  queues: {},
});

/** Local optimistic action: user has just submitted via the composer. We
 *  append the user bubble immediately so the UI is responsive; the daemon's
 *  echoing chat.message_user frame is then deduped by id. */
export type LocalAction =
  | { kind: "set_chat"; chatId: string }
  | { kind: "hydrate"; chatId: string; messages: ReplayMessage[] }
  | { kind: "user_send"; text: string; tempId: string }
  | { kind: "enqueue"; chatId: string; id: string; text: string }
  | { kind: "dequeue"; chatId: string; id: string }
  /** Optimistic cancel — fired after a successful POST /chat/:id/cancel
   *  so the UI flips out of the "running" state immediately, without
   *  waiting for the WS run.end roundtrip. The reducer marks the
   *  in-flight assistant message complete + cancelled and flips runState
   *  to idle. The eventual run.end{status:"cancelled"} frame is idempotent.
   *  No-op if runState is not currently "running" (e.g. user mashed ESC
   *  twice; cancel got a 409). */
  | { kind: "local_cancel" }
  | { kind: "frame"; frame: DaemonFrame };

/** Normalize daemon `output` field — string or block array of {type:"text",text} —
 *  to a plain string. Defensive against unexpected shapes. */
export function normalizeToolOutput(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((p) => {
        if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
          return (p as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  if (raw == null) return "";
  try { return JSON.stringify(raw); } catch { return String(raw); }
}

/** Append a text delta to the in-flight assistant message. Keeps `text` and
 *  the trailing TextPart in `parts` in sync. If the in-flight message has
 *  trailing tool parts, a fresh TextPart is started after them so chunked
 *  text + tools interleave correctly. */
function upsertAssistantDelta(
  msgs: ChatMessage[],
  runId: string,
  delta: string,
): ChatMessage[] {
  const idx = msgs.findIndex((m) => m.id === runId);
  if (idx === -1) {
    return [
      ...msgs,
      {
        id: runId,
        role: "assistant",
        text: delta,
        complete: false,
        parts: [{ kind: "text", text: delta }],
      },
    ];
  }
  const next = msgs.slice();
  const cur = next[idx];
  const curParts = cur.parts ?? (cur.text ? [{ kind: "text" as const, text: cur.text }] : []);
  let newParts: AssistantPart[];
  const last = curParts[curParts.length - 1];
  if (last && last.kind === "text") {
    newParts = curParts.slice(0, -1).concat({ kind: "text", text: last.text + delta });
  } else {
    newParts = curParts.concat({ kind: "text", text: delta });
  }
  next[idx] = { ...cur, text: cur.text + delta, parts: newParts };
  return next;
}

/** Ensure an assistant ChatMessage exists for `runId`. Returns updated msgs +
 *  the index of the (possibly-new) assistant row. */
function ensureAssistant(
  msgs: ChatMessage[],
  runId: string,
): { msgs: ChatMessage[]; idx: number } {
  const idx = msgs.findIndex((m) => m.id === runId && m.role === "assistant");
  if (idx !== -1) return { msgs, idx };
  const next = msgs.concat({
    id: runId,
    role: "assistant",
    text: "",
    complete: false,
    parts: [],
  });
  return { msgs: next, idx: next.length - 1 };
}

function appendToolUse(
  msgs: ChatMessage[],
  runId: string,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
): ChatMessage[] {
  const { msgs: m, idx } = ensureAssistant(msgs, runId);
  const cur = m[idx];
  const curParts = cur.parts ?? (cur.text ? [{ kind: "text" as const, text: cur.text }] : []);
  // Idempotent: if a tool part with this id already exists, leave it.
  if (curParts.some((p) => p.kind === "tool" && p.toolCallId === toolCallId)) return m;
  const newPart: ToolPart = { kind: "tool", toolCallId, name, input, isError: false };
  const next = m.slice();
  next[idx] = { ...cur, parts: curParts.concat(newPart) };
  return next;
}

function applyToolResult(
  msgs: ChatMessage[],
  runId: string,
  toolCallId: string,
  output: unknown,
  isError: boolean,
): ChatMessage[] {
  const { msgs: m, idx } = ensureAssistant(msgs, runId);
  const cur = m[idx];
  const curParts = cur.parts ?? (cur.text ? [{ kind: "text" as const, text: cur.text }] : []);
  const outText = normalizeToolOutput(output);
  const pIdx = curParts.findIndex(
    (p) => p.kind === "tool" && p.toolCallId === toolCallId,
  );
  let nextParts: AssistantPart[];
  if (pIdx === -1) {
    // Defensive: tool_result without matching tool_use. Surface a stub.
    nextParts = curParts.concat({
      kind: "tool",
      toolCallId,
      name: "",
      input: {},
      output: outText,
      isError,
    });
  } else {
    const t = curParts[pIdx] as ToolPart;
    nextParts = curParts.slice();
    nextParts[pIdx] = { ...t, output: outText, isError };
  }
  const next = m.slice();
  next[idx] = { ...cur, parts: nextParts };
  return next;
}

function markAssistantComplete(
  msgs: ChatMessage[],
  runId: string,
  opts: { cancelled?: boolean } = {},
): ChatMessage[] {
  const idx = msgs.findIndex((m) => m.id === runId);
  if (idx === -1) return msgs;
  const cur = msgs[idx];
  const wantCancelled = opts.cancelled === true;
  // Idempotent: if already complete AND cancelled flag already matches, no-op.
  if (cur.complete && (cur.cancelled ?? false) === wantCancelled) return msgs;
  const next = msgs.slice();
  next[idx] = {
    ...cur,
    complete: true,
    // Set cancelled flag explicitly when requested; preserve prior value
    // otherwise (so a stray duplicate run.end{done} can't unset it).
    cancelled: wantCancelled || cur.cancelled === true,
  };
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
      // Preserve the per-chat queue map across chat switches — queued messages
      // belong to the chat they were typed in, not the active session.
      return { ...initialChatState(action.chatId), queues: state.queues };
    }
    case "enqueue": {
      const cur = state.queues[action.chatId] ?? [];
      // Idempotent guard: skip if this id is already queued (rapid double-fire
      // protection — useful when assistant-ui's onNew fires twice for the same
      // synthetic test event, or for any duplicate dispatch).
      if (cur.some((q) => q.id === action.id)) return state;
      return {
        ...state,
        queues: {
          ...state.queues,
          [action.chatId]: [...cur, { id: action.id, text: action.text }],
        },
      };
    }
    case "dequeue": {
      const cur = state.queues[action.chatId] ?? [];
      const next = cur.filter((q) => q.id !== action.id);
      if (next.length === cur.length) return state;
      const queues = { ...state.queues };
      if (next.length === 0) delete queues[action.chatId];
      else queues[action.chatId] = next;
      return { ...state, queues };
    }
    case "hydrate": {
      // Stale-response guard: ignore if reducer has since switched away.
      if (state.chatId !== action.chatId) return state;
      const messages: ChatMessage[] = [];
      let lastAssistantIdx = -1;
      action.messages.forEach((m, i) => {
        if (m.role === "user" || m.role === "assistant") {
          const msg: ChatMessage = {
            id: `replay-${m.role}-${i}`,
            role: m.role,
            text: m.content,
            complete: true,
            parts: m.role === "assistant"
              ? (m.content ? [{ kind: "text", text: m.content }] : [])
              : undefined,
          };
          messages.push(msg);
          if (m.role === "assistant") lastAssistantIdx = messages.length - 1;
        } else if (m.role === "tool_use") {
          if (lastAssistantIdx === -1) {
            // Defensive: tool entry before any assistant turn — synthesize one.
            messages.push({
              id: `replay-assistant-${i}`,
              role: "assistant",
              text: "",
              complete: true,
              parts: [],
            });
            lastAssistantIdx = messages.length - 1;
          }
          const a = messages[lastAssistantIdx];
          const parts = (a.parts ?? []).concat({
            kind: "tool",
            toolCallId: m.tool_call_id,
            name: m.name,
            input: m.input ?? {},
            isError: false,
          });
          messages[lastAssistantIdx] = { ...a, parts };
        } else if (m.role === "tool_result") {
          if (lastAssistantIdx === -1) {
            messages.push({
              id: `replay-assistant-${i}`,
              role: "assistant",
              text: "",
              complete: true,
              parts: [],
            });
            lastAssistantIdx = messages.length - 1;
          }
          const a = messages[lastAssistantIdx];
          const parts = (a.parts ?? []).slice();
          const pIdx = parts.findIndex(
            (p) => p.kind === "tool" && p.toolCallId === m.tool_call_id,
          );
          const outText = normalizeToolOutput(m.output);
          const isError = m.is_error === true;
          if (pIdx === -1) {
            parts.push({
              kind: "tool",
              toolCallId: m.tool_call_id,
              name: "",
              input: {},
              output: outText,
              isError,
            });
          } else {
            const t = parts[pIdx] as ToolPart;
            parts[pIdx] = { ...t, output: outText, isError };
          }
          messages[lastAssistantIdx] = { ...a, parts };
        }
      });
      return { ...state, messages };
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
    case "local_cancel": {
      // Idempotent: only act while running and there's a tracked run id.
      if (state.runState !== "running") return state;
      const rid = state.activeRunId;
      const messages = rid
        ? markAssistantComplete(state.messages, rid, { cancelled: true })
        : state.messages;
      return {
        ...state,
        messages,
        runState: "idle",
        activeRunId: null,
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
        case "chat.tool_use": {
          if (!runId) return state;
          const toolCallId = typeof f.tool_call_id === "string" ? f.tool_call_id : null;
          const name = typeof f.name === "string" ? f.name : "";
          if (!toolCallId) return state;
          const input = (f.input && typeof f.input === "object")
            ? (f.input as Record<string, unknown>)
            : {};
          return {
            ...state,
            messages: appendToolUse(state.messages, runId, toolCallId, name, input),
          };
        }
        case "chat.tool_result": {
          if (!runId) return state;
          const toolCallId = typeof f.tool_call_id === "string" ? f.tool_call_id : null;
          if (!toolCallId) return state;
          const isError = f.is_error === true;
          return {
            ...state,
            messages: applyToolResult(state.messages, runId, toolCallId, f.output, isError),
          };
        }
        case "chat.completion": {
          if (!runId) return state;
          return { ...state, messages: markAssistantComplete(state.messages, runId) };
        }
        case "run.end": {
          if (!runId) return state;
          // run.end is the AUTHORITATIVE terminal frame regardless of status.
          // - "done":      normal completion; chat.completion preceded.
          // - "error":     spawner failure; flip runState to "error".
          // - "cancelled": ESC interrupt; chat.completion is suppressed by
          //                daemon (see VOS-80 e81eb72), so this frame is the
          //                ONLY signal that the stream terminated. Mark the
          //                in-flight assistant complete + cancelled so the UI
          //                renders a "(stopped)" badge and freezes partial
          //                text streamed so far.
          const status = typeof f.status === "string" ? f.status : "done";
          const isCancel = status === "cancelled";
          return {
            ...state,
            messages: markAssistantComplete(state.messages, runId, {
              cancelled: isCancel,
            }),
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
