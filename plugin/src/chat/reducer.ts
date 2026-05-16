// Pure reducer for the chat thread state. Independent of React + assistant-ui
// so it can be unit-tested in isolation (see test/chat-reducer.test.ts).
//
// VOS-80 part 2: DAEMON DB = SOURCE OF TRUTH. The reducer no longer
// reconstructs chat history from chat.token / chat.tool_* deltas. Instead:
//
//   - `messages` is a *cache* of GET /chat/:id/messages. It is replaced
//     wholesale via the `refetched` action (which the runtime dispatches
//     after run.end). The reducer never mutates `messages` from streaming
//     frames.
//   - `liveTokens` + `liveToolEvents` form a transient overlay that the
//     runtime layers AFTER `messages` to show the currently-streaming turn.
//     Both are cleared on run.end / run.error / set_chat / local_cancel.
//   - WS frames are *invalidation signals*: run.start arms the overlay,
//     chat.token / chat.tool_* feed it, run.end disarms it and tells the
//     runtime to refetch.
//
// Wire shape unchanged:
//   chat.message_user  {chat_id, run_id, text}      → user reconcile (kept)
//   run.start          {chat_id, run_id, agent}     → arm overlay
//   chat.token         {chat_id, run_id, delta}     → liveTokens
//   chat.tool_use      {chat_id, run_id, tool_call_id, name, input}     → liveToolEvents
//   chat.tool_result   {chat_id, run_id, tool_call_id, output, is_error}→ merge into liveToolEvents
//   run.end            {chat_id, run_id, status}    → idle + clear overlay
//   run.error          {chat_id, run_id, error}     → error + clear overlay

import type { DaemonFrame } from "./bus";

export type Role = "user" | "assistant";

/** Inline parts on an assistant message. Tool parts are appended in arrival
 *  order (preserves daemon's intra-turn ordering). */
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
  /** When set, this tool call spawned a child task. Points to the child task id
   *  in ChatState.childTasks. Populated by the child-task sub-thread feature
   *  (VOS-91). */
  childTaskId?: string;
};
export type AssistantPart = TextPart | ToolPart;

export interface ChatMessage {
  /** Stable id used for dedupe. For server-sourced rows the daemon supplies
   *  the role + content; we synthesize `replay-<role>-<index>` ids. For
   *  optimistic user_send rows it's `user-temp-*`. For canonical user rows
   *  it's `user-<run_id>`. */
  id: string;
  role: Role;
  /** Concatenated text. Assistant rows mirror the joined TextParts. */
  text: string;
  /** Always true for refetched/replay rows; false only for optimistic
   *  user_send rows awaiting reconciliation. */
  complete: boolean;
  /** True when this assistant turn was terminated via cancel. UI surfaces
   *  a "(stopped)" badge. Tagged by the refetched action when the runtime
   *  passes `stoppedRunId` after a local_cancel-driven refetch. */
  cancelled?: boolean;
  /** Assistant content parts in arrival order. Undefined for user rows. */
  parts?: AssistantPart[];
  /** Marker for synthetic "queued" user bubbles. */
  queued?: boolean;
}

export type RunState = "idle" | "running" | "error";

/** State of a single child-task sub-thread (VOS-91).
 *  Keyed by taskId in ChatState.childTasks. */
export interface ChildTaskStream {
  taskId: string;
  /** Stable synthetic run id for the child overlay: `"child-${taskId}"`. */
  runId: string;
  /** The tool_call_id on the parent assistant turn that spawned this child. */
  parentToolCallId: string;
  /** chatId of the parent chat thread. */
  parentTaskId: string;
  /** Agent name reported by the child daemon. */
  agent: string;
  state: "WORKING" | "INPUT_REQUIRED" | "COMPLETED" | "FAILED" | "CANCELED";
  error: string | null;
  /** Streaming token buffer for the child's current run (mirrors liveTokens). */
  liveTokens: string;
  /** Streaming tool events for the child's current run (mirrors liveToolEvents). */
  liveToolEvents: ToolPart[];
  /** Settled message history fetched from the child daemon (mirrors messages). */
  messages: ChatMessage[];
  /** UI expansion mode. "auto" = infer from state, "expanded"/"collapsed" = user override. */
  manualToggle: "auto" | "expanded" | "collapsed";
}

export type ChildState = ChildTaskStream["state"];
export const TERMINAL_CHILD_STATES: ReadonlySet<ChildState> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
]);

/** A user message that was typed while a run was streaming. Held locally until
 *  the active run ends, then flushed FIFO into POST /chat/:id/message. */
export interface QueuedMessage {
  id: string;
  text: string;
}

/** Replay items returned by GET /chat/:id/messages. */
export type ReplayMessage =
  | {
      role: "user" | "assistant";
      content: string;
      ts?: number;
      /** Server-truth cancelled flag (daemon LEFT JOIN runs.status='cancelled')
       *  surfaced on assistant entries only. The reducer propagates this onto
       *  ChatMessage.cancelled so the "stopped" badge persists across refetch
       *  and chat-switch cycles. */
      cancelled?: boolean;
    }
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

/** Inline error notice surfaced after a run.end{status:"error"} or run.error.
 *  Distinct from `cancelled` (user-initiated) — this is a daemon-side failure
 *  (typically first_event watchdog firing when CC never responded). The UI
 *  renders a muted italic line in place of the missing assistant reply. */
export interface ErrorNotice {
  /** "timeout" → "Claude didn't respond. Try again." (first_event / output / tool watchdog).
   *  "generic" → "Something went wrong. Try again." (other error). */
  kind: "timeout" | "generic";
  /** run_id the error belongs to. Cleared on the next run.start so the
   *  notice doesn't leak across retries. */
  runId: string;
}

export interface ChatState {
  /** Chat id this state is bound to. Frames for other chats are ignored. */
  chatId: string | null;
  /** Cache of GET /chat/:id/messages. Replaced wholesale by `refetched`.
   *  Never mutated by streaming frames. */
  messages: ChatMessage[];
  /** Overlay buffer for the currently-streaming assistant turn. Built from
   *  chat.token deltas. Cleared on run.end / run.error / set_chat. */
  liveTokens: string;
  /** Overlay buffer for tool events in the current run. */
  liveToolEvents: ToolPart[];
  runState: RunState;
  /** run_id of the currently-streaming assistant message, if any. */
  activeRunId: string | null;
  /** Set by local_cancel; consumed by next refetched dispatch to tag the
   *  last assistant entry from that run with cancelled=true. */
  pendingStoppedRunId: string | null;
  /** Inline error notice for the last failed run. Cleared on the next
   *  run.start / set_chat / user_send / local_cancel. */
  errorNotice: ErrorNotice | null;
  /** Per-chat send queue. */
  queues: Record<string, QueuedMessage[]>;
  /** Latest unresolved ask_user prompt for this chat, or null. Single-slot
   *  per daemon invariant (ASK_USER_ALREADY_OPEN). Drives composer mode in
   *  ChatRoot. Cleared only by matching tool_result or set_chat. NOT cleared
   *  by task.state_changed → WORKING (race: a late WORKING from a previous
   *  resume can fire after the next ask_user tool_use lands; see VOS-90 spec D7). */
  pendingAskUser: {
    toolUseId: string;
    question: string;
    options?: string[];
  } | null;
  /** Arrival-order flag for the live overlay parts list. Set to `true` when
   *  the FIRST overlay-bound frame for the current run is a `chat.tool_use`
   *  (i.e. a tool fired before any tokens streamed). Consumed by runtime's
   *  `buildOverlay` to keep the tool part at a stable index across subsequent
   *  token deltas — see VOS-90 T8 tapClientLookup race fix.
   *
   *  Lifecycle:
   *   - reset to `false` on run.start / set_chat / local_cancel / clearOverlay
   *   - flipped to `true` by chat.tool_use only when both liveTokens === ""
   *     and liveToolEvents.length === 0 (i.e. nothing streamed yet) */
  liveToolsFirst: boolean;
  /** Child task sub-threads keyed by taskId (VOS-91). Populated by
   *  chat.child_task_started / chat.task.state_changed frames. */
  childTasks: Record<string, ChildTaskStream>;
  /** Maps a parent tool_call_id → childTaskId for O(1) lookup when routing
   *  child WS frames (chat.token, chat.tool_use, …) back to the right child. */
  toolCallToChild: Record<string, string>;
}

export const initialChatState = (chatId: string | null = null): ChatState => ({
  chatId,
  messages: [],
  liveTokens: "",
  liveToolEvents: [],
  runState: "idle",
  activeRunId: null,
  pendingStoppedRunId: null,
  errorNotice: null,
  queues: {},
  pendingAskUser: null,
  liveToolsFirst: false,
  childTasks: {},
  toolCallToChild: {},
});

/** Classify a run.end / run.error error string into a notice kind. The
 *  daemon's first_event watchdog stamps the error with a "timeout" marker
 *  (see cc-watchdog phase=first_event). */
export function classifyError(raw: unknown): ErrorNotice["kind"] {
  if (typeof raw !== "string") return "generic";
  const s = raw.toLowerCase();
  if (s.includes("timeout") || s.includes("first_event") || s.includes("no_response")) {
    return "timeout";
  }
  return "generic";
}

export type LocalAction =
  | { kind: "set_chat"; chatId: string }
  /** Replace `messages` with rows from GET /chat/:id/messages.
   *  If `stoppedRunId` is set AND a recent assistant entry exists, the LAST
   *  assistant entry is marked cancelled (visual cue after ESC). */
  | { kind: "refetched"; chatId: string; messages: ReplayMessage[]; stoppedRunId?: string }
  /** Back-compat alias for `refetched` — kept so legacy tests + the
   *  one-shot initial hydrate effect in runtime.ts still work. Same payload. */
  | { kind: "hydrate"; chatId: string; messages: ReplayMessage[] }
  | { kind: "user_send"; text: string; tempId: string }
  | { kind: "enqueue"; chatId: string; id: string; text: string }
  | { kind: "dequeue"; chatId: string; id: string }
  /** Optimistic cancel — flips idle + clears overlay + arms pendingStoppedRunId
   *  so the next refetched dispatch (triggered by run.end{cancelled}) tags
   *  the partial assistant entry as cancelled. No-op when not running. */
  | { kind: "local_cancel" }
  | { kind: "local_answer_409" }
  | { kind: "frame"; frame: DaemonFrame }
  /** Toggle a child task's expansion state. "auto" reverts to state-driven logic;
   *  "expanded" / "collapsed" are sticky user overrides. (VOS-91 T16) */
  | { kind: "child_toggle"; childTaskId: string; next: "expanded" | "collapsed" };

/** Normalize daemon `output` field — string or block array of {type:"text",text} —
 *  to a plain string. */
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

/** Convert ReplayMessage[] to ChatMessage[]. Tool entries are attached to
 *  the nearest preceding assistant message as TextPart/ToolPart entries. */
function replayToMessages(rows: ReplayMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let lastAssistantIdx = -1;
  rows.forEach((m, i) => {
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
      // Server-truth cancelled flag (daemon LEFT JOIN runs.status='cancelled')
      // on assistant entries. Survives without `pendingStoppedRunId` so the
      // badge is durable across refetch and chat-switch.
      if (m.role === "assistant" && m.cancelled === true) {
        msg.cancelled = true;
      }
      messages.push(msg);
      if (m.role === "assistant") lastAssistantIdx = messages.length - 1;
    } else if (m.role === "tool_use") {
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
  return messages;
}

/** Replace the optimistic user bubble (id starting with "user-temp-") with
 *  the canonical id derived from run_id, OR append if not present. Idempotent. */
function reconcileUser(
  msgs: ChatMessage[],
  runId: string,
  text: string,
): ChatMessage[] {
  const canonicalId = `user-${runId}`;
  if (msgs.some((m) => m.id === canonicalId)) return msgs;
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

/** Append delta to liveTokens overlay. */
function appendLiveDelta(state: ChatState, delta: string): ChatState {
  if (!delta) return state;
  return { ...state, liveTokens: state.liveTokens + delta };
}

function appendLiveToolUse(
  state: ChatState,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
): ChatState {
  if (state.liveToolEvents.some((p) => p.toolCallId === toolCallId)) return state;
  const newPart: ToolPart = { kind: "tool", toolCallId, name, input, isError: false };
  return { ...state, liveToolEvents: state.liveToolEvents.concat(newPart) };
}

function applyLiveToolResult(
  state: ChatState,
  toolCallId: string,
  output: unknown,
  isError: boolean,
): ChatState {
  const outText = normalizeToolOutput(output);
  const idx = state.liveToolEvents.findIndex((p) => p.toolCallId === toolCallId);
  if (idx === -1) {
    return {
      ...state,
      liveToolEvents: state.liveToolEvents.concat({
        kind: "tool",
        toolCallId,
        name: "",
        input: {},
        output: outText,
        isError,
      }),
    };
  }
  const next = state.liveToolEvents.slice();
  next[idx] = { ...next[idx], output: outText, isError };
  return { ...state, liveToolEvents: next };
}

/** Clear all transient overlay state. Called on run.end / run.error /
 *  set_chat / local_cancel. */
function clearOverlay(state: ChatState): ChatState {
  if (
    state.liveTokens === "" &&
    state.liveToolEvents.length === 0 &&
    state.activeRunId === null &&
    state.liveToolsFirst === false
  ) {
    return state;
  }
  return {
    ...state,
    liveTokens: "",
    liveToolEvents: [],
    activeRunId: null,
    liveToolsFirst: false,
  };
}

/** Tag the cancelled run's assistant entry in `messages`. Used by refetched
 *  when `stoppedRunId` is set.
 *
 *  Two shapes possible:
 *   1. Daemon persisted an assistant row for the cancelled run (any tokens
 *      streamed before ESC). The row is the LAST message in the array —
 *      tag it cancelled=true so the renderer shows the "↯ stopped" badge.
 *   2. No assistant row was persisted (ESC fired before any tokens, so the
 *      daemon's appendAssistant skipped the empty turn). The LAST message
 *      is then the user prompt that triggered the cancelled run. We
 *      synthesize an empty cancelled assistant entry AFTER it so the
 *      renderer attaches the badge to the correct turn — NOT to a prior
 *      successful assistant message that happens to be above the user msg. */
function tagLastAssistantCancelled(
  msgs: ChatMessage[],
  stoppedRunId: string,
): ChatMessage[] {
  if (msgs.length === 0) return msgs;
  const last = msgs[msgs.length - 1];
  if (last.role === "assistant") {
    const next = msgs.slice();
    next[next.length - 1] = { ...last, cancelled: true };
    return next;
  }
  // Last entry is the user prompt for the cancelled run — daemon never
  // persisted an empty assistant row. Append a synthetic empty cancelled
  // assistant; toThreadMessage renders it as the STOPPED_MARKER bubble.
  return [
    ...msgs,
    {
      id: `assistant-cancelled-${stoppedRunId}`,
      role: "assistant",
      text: "",
      complete: true,
      cancelled: true,
      parts: [],
    },
  ];
}

export function chatReducer(state: ChatState, action: LocalAction): ChatState {
  switch (action.kind) {
    case "set_chat": {
      if (state.chatId === action.chatId) return state;
      // Preserve queue map; reset everything else (incl. errorNotice).
      return { ...initialChatState(action.chatId), queues: state.queues };
    }
    case "enqueue": {
      const cur = state.queues[action.chatId] ?? [];
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
    case "hydrate":
    case "refetched": {
      // Stale-response guard: ignore if reducer has since switched away.
      if (state.chatId !== action.chatId) return state;
      const isRefetch = action.kind === "refetched";
      const stoppedRunId = isRefetch ? action.stoppedRunId : undefined;

      // ── T15: rebuild childTasks from synthetic child_task_started entries ──

      // 1. Snapshot prior manualToggle so user-set expansions survive refetch.
      const priorToggle = new Map<string, ChildTaskStream["manualToggle"]>();
      for (const [tid, st] of Object.entries(state.childTasks)) {
        priorToggle.set(tid, st.manualToggle);
      }

      // 2. Build nextChildTasks from child_task_started synthetic entries.
      const nextChildTasks: Record<string, ChildTaskStream> = {};
      const nextToolCallToChild: Record<string, string> = {};
      const childEntries: Record<string, ReplayMessage[]> = {};
      const rawMessages = action.messages as unknown as Array<ReplayMessage & { role: string; task_id?: string; child_task_id?: string; parent_task_id?: string; parent_tool_call_id?: string; agent?: string; task_state?: string; chat_id?: string }>;
      const startEntries = rawMessages.filter((m) => m.role === "child_task_started");
      for (const cts of startEntries) {
        const cid = cts.child_task_id!;
        const wireState = cts.task_state ?? "WORKING";
        const uiState: ChildState =
          wireState === "INPUT_REQUIRED" ? "INPUT_REQUIRED" :
          wireState === "COMPLETED" || wireState === "FAILED" || wireState === "CANCELED"
            ? (wireState as ChildState)
            : "WORKING";
        nextChildTasks[cid] = {
          taskId: cid,
          runId: `child-${cid}`,
          parentToolCallId: cts.parent_tool_call_id!,
          parentTaskId: cts.parent_task_id!,
          agent: cts.agent ?? "",
          state: uiState,
          error: null,
          liveTokens: "",
          liveToolEvents: [],
          messages: [],
          manualToggle: priorToggle.get(cid) ?? "auto",
        };
        nextToolCallToChild[cts.parent_tool_call_id!] = cid;
        childEntries[cid] = [];
      }

      // 3. Partition replay entries by task_id — child rows are pulled out.
      const parentEntries: ReplayMessage[] = [];
      for (const m of rawMessages) {
        if (m.role === "child_task_started") continue;
        const tid = m.task_id;
        if (tid && nextChildTasks[tid]) {
          childEntries[tid].push(m as ReplayMessage);
        } else {
          parentEntries.push(m as ReplayMessage);
        }
      }

      // 4. Build messages for each child group; attach childTaskId on ask_agent ToolParts.
      for (const cid of Object.keys(nextChildTasks)) {
        const childMsgs = replayToMessages(childEntries[cid]);
        for (const msg of childMsgs) {
          if (!msg.parts) continue;
          for (let pi = 0; pi < msg.parts.length; pi++) {
            const p = msg.parts[pi];
            if (p.kind !== "tool" || p.name !== "ask_agent") continue;
            const grandchildId = nextToolCallToChild[p.toolCallId];
            if (grandchildId) msg.parts[pi] = { ...p, childTaskId: grandchildId };
          }
        }
        nextChildTasks[cid].messages = childMsgs;
      }

      // 5. Build parent messages + attach childTaskId on ask_agent ToolParts.
      let messages = replayToMessages(parentEntries);
      for (const msg of messages) {
        if (!msg.parts) continue;
        for (let pi = 0; pi < msg.parts.length; pi++) {
          const p = msg.parts[pi];
          if (p.kind !== "tool" || p.name !== "ask_agent") continue;
          const childId = nextToolCallToChild[p.toolCallId];
          if (childId) msg.parts[pi] = { ...p, childTaskId: childId };
        }
      }

      // ── end T15 ──

      const shouldTagStopped =
        stoppedRunId !== undefined &&
        (state.pendingStoppedRunId === stoppedRunId ||
          state.pendingStoppedRunId === null && stoppedRunId !== "");
      if (shouldTagStopped) {
        messages = tagLastAssistantCancelled(messages, stoppedRunId);
      }
      // Rehydrate pendingAskUser from ALL replay entries (parent + child).
      // Bug fix (T15): if a CHILD task issued ask_user, its row has
      // task_id === childTaskId and was partitioned into childEntries[], so
      // scanning only parentEntries misses it. The daemon's single-slot
      // invariant (ASK_USER_ALREADY_OPEN) guarantees at most one unpaired
      // ask_user across the whole Context regardless of which task issued it.
      const allRows = rawMessages.filter((m) => m.role !== "child_task_started") as ReplayMessage[];
      const askUserRows = allRows
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.role === "tool_use" && (m as ReplayMessage & { role: "tool_use" }).name === "ask_user");
      const unpaired: Array<{ tool_use: ReplayMessage & { role: "tool_use" }; idx: number }> = [];
      for (const { m, i } of askUserRows) {
        const tu = m as ReplayMessage & { role: "tool_use" };
        const paired = allRows
          .slice(i + 1)
          .some((later) => later.role === "tool_result" && (later as ReplayMessage & { role: "tool_result" }).tool_call_id === tu.tool_call_id);
        if (!paired) unpaired.push({ tool_use: tu, idx: i });
      }
      let nextPendingAskUser: ChatState["pendingAskUser"] = null;
      if (unpaired.length > 0) {
        const latest = unpaired[unpaired.length - 1].tool_use;
        const input = (latest.input ?? {}) as { question?: unknown; options?: unknown };
        const question = typeof input.question === "string" ? input.question : "";
        const options = Array.isArray(input.options)
          ? (input.options as unknown[]).filter((o): o is string => typeof o === "string")
          : undefined;
        nextPendingAskUser = {
          toolUseId: latest.tool_call_id,
          question,
          options,
        };
        if (unpaired.length > 1) {
          // eslint-disable-next-line no-console
          console.warn(
            "[void-os] ask_user invariant violated: %d unpaired prompts on refetch",
            unpaired.length,
          );
        }
      }
      return {
        ...state,
        messages,
        childTasks: nextChildTasks,
        toolCallToChild: nextToolCallToChild,
        // Refetch reflects the canonical post-run state — clear overlay so
        // we don't double-render the streaming turn next to its persisted form.
        liveTokens: isRefetch ? "" : state.liveTokens,
        liveToolEvents: isRefetch ? [] : state.liveToolEvents,
        pendingStoppedRunId: isRefetch ? null : state.pendingStoppedRunId,
        pendingAskUser: nextPendingAskUser,
      };
    }
    case "user_send": {
      // Optimistic append. Reconciled when chat.message_user echoes.
      // Clear any prior errorNotice — a new user send is the user's retry.
      return {
        ...state,
        errorNotice: null,
        messages: [
          ...state.messages,
          { id: action.tempId, role: "user", text: action.text, complete: true },
        ],
      };
    }
    case "local_cancel": {
      // Optimistic ESC flip: runState idle now, pendingStoppedRunId armed
      // so the runtime renders the live overlay with a "(stopped)" badge
      // and the next refetch will tag the persisted assistant entry.
      //
      // We INTENTIONALLY do not clear liveTokens/liveToolEvents here —
      // they stay rendered (as a stopped overlay) until the daemon's
      // run.end arrives, at which point the refetch replaces the entire
      // turn with canonical state.
      //
      // VOS-80 stopped-badge fix (1): when there is NO overlay content
      // yet (ESC fired before any tokens/tools streamed), synthesize an
      // empty cancelled assistant directly into `messages` so the badge
      // appears within one frame of ESC — not after the daemon round-trip
      // (run.end → refetch). When the refetch later lands, replayToMessages
      // wholesale-replaces `messages` with daemon truth (which now carries
      // a persisted empty cancelled row courtesy of the orchestrator
      // finally block, tagged via the LEFT JOIN). Idempotent — no
      // double-bubble.
      //
      // If overlay content DOES exist (partial-text cancel), the runtime's
      // buildOverlay path already renders the partial bubble with badge
      // (driven by pendingStoppedRunId). Synthesizing here would
      // double-render. So we only synthesize when overlay is empty.
      if (state.runState !== "running") return state;
      const runId = state.activeRunId;
      const hasOverlay =
        state.liveTokens !== "" || state.liveToolEvents.length > 0;
      let messages = state.messages;
      if (!hasOverlay && runId !== null) {
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          // Tail is an assistant row (rare — happens only if a prior turn's
          // assistant is still the tail when ESC fires). Tag it cancelled
          // in place so the badge attaches to the right bubble.
          messages = messages.slice();
          messages[messages.length - 1] = { ...last, cancelled: true };
        } else {
          // Tail is the user prompt (or empty) — append a synthetic empty
          // cancelled assistant so the badge attaches to the cancelled
          // turn, not to any prior assistant message above the user prompt.
          messages = [
            ...messages,
            {
              id: `assistant-cancelled-${runId}`,
              role: "assistant",
              text: "",
              complete: true,
              cancelled: true,
              parts: [],
            },
          ];
        }
      }
      return {
        ...state,
        messages,
        runState: "idle",
        activeRunId: null,
        pendingStoppedRunId: runId,
        errorNotice: null,
      };
    }
    case "local_answer_409": {
      if (!state.pendingAskUser) return state;
      return { ...state, pendingAskUser: null };
    }
    case "child_toggle": {
      const cur = state.childTasks[action.childTaskId];
      if (!cur) return state;
      if (cur.manualToggle === action.next) return state;
      return {
        ...state,
        childTasks: {
          ...state.childTasks,
          [action.childTaskId]: { ...cur, manualToggle: action.next },
        },
      };
    }
    case "frame": {
      const f = action.frame;
      const fChat = typeof f.chat_id === "string" ? f.chat_id : null;
      if (state.chatId && fChat && fChat !== state.chatId) return state;
      const runId = typeof f.run_id === "string" ? f.run_id : null;

      switch (f.type) {
        case "run.start": {
          if (!runId) return state;
          // Fresh run starts: clear any stale overlay from a prior aborted run.
          // Also clear errorNotice — a new run is the user's retry / fresh attempt.
          return {
            ...state,
            liveTokens: "",
            liveToolEvents: [],
            liveToolsFirst: false,
            runState: "running",
            activeRunId: runId,
            errorNotice: null,
          };
        }
        case "chat.message_user": {
          if (!runId) return state;
          const text = typeof f.text === "string" ? f.text : "";
          return { ...state, messages: reconcileUser(state.messages, runId, text) };
        }
        case "chat.token": {
          if (!runId) return state;
          const taskId = typeof f.task_id === "string" ? f.task_id : null;
          if (taskId && state.childTasks[taskId]) {
            const cur = state.childTasks[taskId];
            const delta = typeof f.delta === "string" ? f.delta : "";
            if (!delta) return state;
            return {
              ...state,
              childTasks: {
                ...state.childTasks,
                [taskId]: { ...cur, liveTokens: cur.liveTokens + delta },
              },
            };
          }
          const delta = typeof f.delta === "string" ? f.delta : "";
          return appendLiveDelta(state, delta);
        }
        case "chat.tool_use": {
          if (!runId) return state;
          const toolCallId = typeof f.tool_call_id === "string" ? f.tool_call_id : null;
          const name = typeof f.name === "string" ? f.name : "";
          if (!toolCallId) return state;
          const input = (f.input && typeof f.input === "object")
            ? (f.input as Record<string, unknown>)
            : {};
          const taskIdTu = typeof f.task_id === "string" ? f.task_id : null;
          if (taskIdTu && state.childTasks[taskIdTu]) {
            const cur = state.childTasks[taskIdTu];
            if (cur.liveToolEvents.some((p) => p.toolCallId === toolCallId)) return state;
            const newPart: ToolPart = { kind: "tool", toolCallId, name, input, isError: false };
            return {
              ...state,
              childTasks: {
                ...state.childTasks,
                [taskIdTu]: { ...cur, liveToolEvents: cur.liveToolEvents.concat(newPart) },
              },
            };
          }
          // Arrival-order tracker: if this tool fired before any tokens AND
          // no prior tools, mark the overlay as "tools first" so buildOverlay
          // keeps tools at index 0 when text streams in later (ask_user case).
          const toolsFirst =
            state.liveToolsFirst ||
            (state.liveTokens === "" && state.liveToolEvents.length === 0);
          const withFlag = state.liveToolsFirst === toolsFirst
            ? state
            : { ...state, liveToolsFirst: toolsFirst };
          const next = appendLiveToolUse(withFlag, toolCallId, name, input);
          if (name !== "ask_user") return next;
          const question = typeof input.question === "string" ? input.question : "";
          const options = Array.isArray(input.options)
            ? (input.options as unknown[]).filter((o): o is string => typeof o === "string")
            : undefined;
          return {
            ...next,
            pendingAskUser: { toolUseId: toolCallId, question, options },
          };
        }
        case "chat.tool_result": {
          if (!runId) return state;
          const toolCallId = typeof f.tool_call_id === "string" ? f.tool_call_id : null;
          if (!toolCallId) return state;
          const isError = f.is_error === true;
          const taskIdTr = typeof f.task_id === "string" ? f.task_id : null;
          if (taskIdTr && state.childTasks[taskIdTr]) {
            const cur = state.childTasks[taskIdTr];
            const outText = normalizeToolOutput(f.output);
            const idx = cur.liveToolEvents.findIndex((p) => p.toolCallId === toolCallId);
            let nextEvents: ToolPart[];
            if (idx === -1) {
              nextEvents = cur.liveToolEvents.concat({
                kind: "tool",
                toolCallId,
                name: "",
                input: {},
                output: outText,
                isError,
              });
            } else {
              nextEvents = cur.liveToolEvents.slice();
              nextEvents[idx] = { ...nextEvents[idx], output: outText, isError };
            }
            return {
              ...state,
              childTasks: {
                ...state.childTasks,
                [taskIdTr]: { ...cur, liveToolEvents: nextEvents },
              },
            };
          }
          const next = applyLiveToolResult(state, toolCallId, f.output, isError);
          if (state.pendingAskUser && state.pendingAskUser.toolUseId === toolCallId) {
            return { ...next, pendingAskUser: null };
          }
          return next;
        }
        case "run.end": {
          if (!runId) return state;
          const status = typeof f.status === "string" ? f.status : "done";
          // If runtime hasn't already armed pendingStoppedRunId via
          // local_cancel, and the daemon says cancelled, arm it now so the
          // refetch can tag the last assistant entry.
          const isCancel = status === "cancelled";
          const pending =
            state.pendingStoppedRunId ??
            (isCancel ? runId : null);
          // Error-status terminals: surface an inline notice keyed off the
          // error string. The first_event watchdog stamps "timeout"; other
          // failures get the generic notice. done / cancelled clear notice.
          const errorNotice =
            status === "error"
              ? { kind: classifyError(f.error), runId }
              : null;
          return {
            ...clearOverlay(state),
            runState: status === "error" ? "error" : "idle",
            pendingStoppedRunId: pending,
            errorNotice,
          };
        }
        case "run.error": {
          if (!runId) return state;
          return {
            ...clearOverlay(state),
            runState: "error",
            errorNotice: { kind: classifyError(f.error), runId },
          };
        }
        case "chat.child_task_started": {
          const cid = f.child_task_id;
          if (state.childTasks[cid]) return state; // idempotent on reconnect
          const stream: ChildTaskStream = {
            taskId: cid,
            runId: `child-${cid}`,
            parentToolCallId: f.parent_tool_call_id,
            parentTaskId: f.parent_task_id,
            agent: f.agent,
            state: "WORKING",
            error: null,
            liveTokens: "",
            liveToolEvents: [],
            messages: [],
            manualToggle: "auto",
          };
          return {
            ...state,
            childTasks: { ...state.childTasks, [cid]: stream },
            toolCallToChild: {
              ...state.toolCallToChild,
              [stream.parentToolCallId]: cid,
            },
          };
        }
        case "chat.task.state_changed": {
          const tid = f.task_id;
          if (!state.childTasks[tid]) return state;
          const wireState = f.state;
          const uiState: ChildState =
            wireState === "INPUT_REQUIRED" ? "INPUT_REQUIRED" :
            wireState === "COMPLETED" || wireState === "FAILED" || wireState === "CANCELED" ? wireState :
            "WORKING";
          const error = f.error ?? null;
          return {
            ...state,
            childTasks: {
              ...state.childTasks,
              [tid]: { ...state.childTasks[tid], state: uiState, error },
            },
          };
        }
        default:
          return state;
      }
    }
  }
}
