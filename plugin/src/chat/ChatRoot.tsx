import * as React from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  useAui,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

import type { FrameBus } from "./bus";
import type { ChatApi } from "./api";
import type { AgentListEntry as ProtocolAgentListEntry } from "@voidos/protocol";
import type { AgentListEntry } from "../agents/types";
import type { AgentsApi } from "../agents/api";
import { DraftLabel } from "./DraftLabel";
import {
  useChatRuntime,
  QUEUED_MARKER,
  STOPPED_MARKER,
  TIMEOUT_MARKER,
  ERROR_MARKER,
} from "./runtime";
import { ChatList } from "./ChatList";
import { AgentList } from "./AgentList";
import { CostMeter } from "./CostMeter";
import { focusComposerInputSafely } from "./focus-composer";
import { BashTool } from "./tools/BashTool";
import { GenericTool } from "./tools/GenericTool";
import { AskUserTool } from "./tools/AskUserTool";
import { AskAgentTool } from "./tools/AskAgentTool";
import { DenialPart } from "./tools/DenialPart";
import { AskUserContext, type AskUserContextValue } from "./AskUserContext";
import { ChildTaskContext } from "./ChildTaskContext";

export interface ChatRootProps {
  bus: FrameBus;
  api: ChatApi;
  agentsApi: Pick<AgentsApi, "listAgents">;
  chatId: string | null;
  onChatIdMinted?: (id: string) => void | Promise<void>;
  defaultAgent?: string;
  openPicker: () => Promise<AgentListEntry | null>;
  /** Mount-time callback: receives an imperative setter so external code
   *  (e.g. the Obsidian command that opens this view + mints a chat) can
   *  push a chat id into the React tree after the leaf is already open.
   *  Without this, props.chatId is only consulted on prop change — a fresh
   *  chat minted while the view is already mounted would not become active. */
  registerSetActiveChatId?: (setter: (id: string) => void) => void;
}

// VOS-92: wire the "+ New chat" flow.
// - Opens the agent picker; awaits its resolution.
// - On pick, mints a chat via api.createChat(agent.name) and refreshes.
// - On null (user dismissed), no-op.
//
// VOS-153 T5: superseded by the Draft pane for in-pane agent picks (no chat
// row materialises until first send). The "+ New chat" sidebar button still
// uses this wire — it opens the modal picker and creates a row immediately,
// matching its eager-creation semantics. The agent-list rail goes through
// the state machine instead.
export interface WireOnNewChatDeps {
  api: { createChat(agent?: string): Promise<{ id: string; title: string; created_at: number }> };
  openPicker: () => Promise<AgentListEntry | null>;
  onChatIdMinted?: (id: string, agentName: string) => void | Promise<void>;
  bumpRefresh: () => void;
  fallbackAgent?: string;  // defensive: if picker returns an entry with empty name
}

export function wireOnNewChat(deps: WireOnNewChatDeps): () => Promise<void> {
  return async () => {
    const picked = await deps.openPicker();
    if (!picked) return;
    const agentName = picked.name || deps.fallbackAgent || "";
    const created = await deps.api.createChat(agentName);
    await deps.onChatIdMinted?.(created.id, agentName);
    deps.bumpRefresh();
  };
}

// VOS-153 T5: explicit chat-pane state machine.
//   idle   — no agent picked, no chat selected. Empty hint visible.
//   draft  — agent picked from the rail, but the daemon does not yet know
//            about this conversation. No chat id, no chat row in the list.
//            First send transitions to active (with rollback on failure).
//   active — chat exists on the daemon (id known). Standard runtime path.
export type PaneState =
  | { kind: "idle" }
  | { kind: "draft"; agent: ProtocolAgentListEntry }
  | { kind: "active"; chatId: string; agent: ProtocolAgentListEntry };

// Cheap helper to widen the plugin-local AgentListEntry (a minimal
// name/description subset) to the protocol shape (with optional
// color/avatar/tagline). The daemon serialises the rich fields whenever
// the agent.md frontmatter supplies them — the plugin type is a
// pre-VOS-153 narrowing kept for backwards compat with sibling callers.
function widenAgent(entry: AgentListEntry): ProtocolAgentListEntry {
  const e = entry as ProtocolAgentListEntry;
  return {
    name: e.name,
    description: e.description,
    color: e.color,
    avatar: e.avatar,
    tagline: e.tagline,
  };
}

// User TextPart: detect the queued marker in the part text, strip it, and
// render a small "↻ queued" badge alongside. Plain user messages render as
// before (a bare text span). assistant-ui forwards the part text via props.
function UserTextPart(props: { text?: string } & Record<string, unknown>) {
  const raw = typeof props.text === "string" ? props.text : "";
  const isQueued = raw.startsWith(QUEUED_MARKER);
  if (!isQueued) return <MessagePartPrimitive.Text />;
  const stripped = raw.slice(QUEUED_MARKER.length);
  return (
    <span
      data-testid="queued-content"
      className="vos-queued"
      style={{ opacity: 0.6 }}
    >
      <span
        data-testid="queued-badge"
        className="vos:mr-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-muted)]"
      >
        ↻ queued
      </span>
      <span>{stripped}</span>
    </span>
  );
}

// Assistant Text part: render markdown. `MarkdownTextPrimitive` reads the
// current part's text via assistant-ui context, so no props need forwarding.
// `vos-md` scopes our markdown CSS to this wrapper only.
//
// Special-case: a part whose text === STOPPED_MARKER is the cancellation
// sentinel appended by toThreadMessage. Render a small "(stopped)" badge
// instead of the marker body so the user sees a visual confirmation that
// ESC took effect on this turn.
function MarkdownText(props: { text?: string } & Record<string, unknown>) {
  const raw = typeof props.text === "string" ? props.text : "";
  if (raw === STOPPED_MARKER) {
    // Inline badge — sits at the end of the assistant's last paragraph
    // (toThreadMessage appends STOPPED_MARKER as the trailing text part).
    // Italic + error-tinted 11px keeps it visually distinct from a normal
    // cancellation completion AND from the timeout error notice (muted).
    return (
      <span
        data-testid="stopped-badge"
        className="vos-stopped vos:ml-[var(--size-4-1)] vos:text-[11px] vos:italic vos:text-[var(--text-error)] vos:align-baseline"
      >
        ↯ stopped
      </span>
    );
  }
  if (raw === TIMEOUT_MARKER) {
    // Daemon's first_event/output/tool watchdog fired → CC never produced
    // a usable reply. Renders in place of the missing assistant text.
    return (
      <span
        data-testid="timeout-notice"
        className="vos-timeout-notice vos:text-[12px] vos:italic vos:text-[var(--text-muted)]"
      >
        Claude didn&apos;t respond. Try again.
      </span>
    );
  }
  if (raw === ERROR_MARKER) {
    // Generic run.error (non-timeout). Same muted treatment, different copy.
    return (
      <span
        data-testid="error-notice"
        className="vos-error-notice vos:text-[12px] vos:italic vos:text-[var(--text-muted)]"
      >
        Something went wrong. Try again.
      </span>
    );
  }
  return <MarkdownTextPrimitive className="vos-md" smooth={false} />;
}

function MessageItem() {
  return (
    <MessagePrimitive.Root className="vos:w-full vos:my-[var(--size-4-2)] vos:flex vos:flex-col vos-fade-in">
      {/* User: right-aligned tinted bubble */}
      <MessagePrimitive.If user>
        <div className="vos:flex vos:justify-end">
          <div
            className="vos:max-w-[85%] vos:rounded-[var(--radius-m)] vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:bg-[var(--background-secondary)] vos:text-[var(--text-normal)] vos:whitespace-pre-wrap vos:leading-relaxed"
          >
            <MessagePrimitive.Parts components={{ Text: UserTextPart }} />
          </div>
        </div>
      </MessagePrimitive.If>
      {/* Assistant: full-width, left-edge accent, no bg, no label */}
      <MessagePrimitive.If assistant>
        <div
          className="vos:border-l-2 vos:border-[var(--interactive-accent)] vos:pl-[var(--size-4-3)] vos:text-[var(--text-normal)] vos:leading-relaxed"
        >
          <MessagePrimitive.Parts
            components={{
              Text: MarkdownText,
              // Bash registers itself globally via makeAssistantToolUI (rendered
              // once below). Any other tool name falls back to the generic block.
              tools: { Fallback: GenericTool },
              // VOS-109: synthesised denial DataMessagePart, keyed on
              // `data.name === "denial"`. See plugin/src/chat/tools/DenialPart.tsx.
              data: { by_name: { denial: DenialPart } },
            }}
          />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

// Three-dot thinking indicator. Visible whenever the thread is running
// EXCEPT while paused at an `ask_user` prompt — the agent is not thinking,
// it is waiting for the operator. The AskUserTool's own UI is the only
// indicator that belongs there. (VOS-142 follow-up.)
//
// Approach: always render the dots while running. If the assistant has not
// begun streaming, the dots sit alone below the user's last message. Once
// a partial assistant message exists, the dots sit beneath the streaming
// bubble as a "still working" pulse — the streaming text itself is the
// primary signal, dots are secondary. This avoids needing to inspect the
// last-message role from outside the messages list.
function ThinkingIndicator() {
  const { chatState } = React.useContext(ChildTaskContext);
  if (chatState.pendingAskUser) return null;
  return (
    <ThreadPrimitive.If running>
      <div className="vos:w-full vos:my-[var(--size-4-2)]">
        <div className="vos:border-l-2 vos:border-[var(--interactive-accent)] vos:pl-[var(--size-4-3)]">
          <span className="vos-dots" aria-label="thinking">
            <span className="vos-dot" />
            <span className="vos-dot" />
            <span className="vos-dot" />
          </span>
        </div>
      </div>
    </ThreadPrimitive.If>
  );
}

// Custom Send button rendered ONLY while a run is streaming.
//
// Why: assistant-ui's built-in `ComposerPrimitive.Send` returns null whenever
// `thread.isRunning && !thread.capabilities.queue` — and the external-store
// runtime hardcodes `queue: false`. So the moment we (correctly) tell
// assistant-ui that a run is in flight, the default Send button vanishes.
//
// We replace it with a tiny button that reads the composer's current text
// out of assistant-ui's store, hands it to the runtime's imperative `send()`
// (which enqueues during a run, POSTs otherwise), then clears the input.
//
// The composer textarea (`ComposerPrimitive.Input`) stays a normal,
// always-writable textarea — only the Send button gets swapped.
function QueueSendButton(props: { send: (text: string) => Promise<void> }) {
  const aui = useAui();
  const onClick = React.useCallback(() => {
    const composer = aui.composer();
    const text = composer.getState().text;
    if (!text.trim()) return;
    composer.setText("");
    void props.send(text);
  }, [aui, props]);
  return (
    <button
      type="button"
      data-testid="queue-send"
      onClick={onClick}
      className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-1)] vos:rounded-[var(--radius-s)] vos:bg-[var(--interactive-accent)] vos:text-[var(--text-on-accent)] vos:border vos:border-transparent hover:vos:bg-[var(--interactive-accent-hover)]"
    >
      Send
    </button>
  );
}

// VOS-142: while a run is in flight (including the ask_user pause),
// assistant-ui's built-in Send button is replaced by QueueSendButton and the
// textarea no longer treats Enter as submit. Wire Enter (no shift/cmd/ctrl/alt,
// not mid-IME) to the same composer.setText + send path the button uses.
// Lives inside AssistantRuntimeProvider so useAui() resolves.
function ComposerKeyboardHandler(props: {
  isRunning: boolean;
  pendingAskUserButtonsOnly: boolean;
  send: (text: string) => Promise<void>;
  cancel: () => void | Promise<unknown>;
  children: React.ReactNode;
  className?: string;
}) {
  const aui = useAui();
  const onKeyDownCapture = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      const isTextarea =
        target?.tagName === "TEXTAREA" ||
        (target as { isContentEditable?: boolean })?.isContentEditable === true;
      if (!isTextarea) return;
      if (e.key === "Escape") {
        if (!props.isRunning) return;
        e.preventDefault();
        void props.cancel();
        return;
      }
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.nativeEvent.isComposing !== true
      ) {
        if (!props.isRunning) return;
        if (props.pendingAskUserButtonsOnly) {
          e.preventDefault();
          return;
        }
        const composer = aui.composer();
        const text = composer.getState().text;
        if (!text.trim()) return;
        e.preventDefault();
        composer.setText("");
        void props.send(text);
      }
    },
    [aui, props],
  );
  return (
    <div className={props.className} onKeyDownCapture={onKeyDownCapture}>
      {props.children}
    </div>
  );
}

export function ChatRoot(props: ChatRootProps) {
  // VOS-153 T5: explicit Idle / Draft / Active state machine. The
  // pre-T5 shape (independent activeChatId + activeAgent strings) is
  // derived from `pane` so existing hooks downstream — useChatRuntime,
  // ChatList selection, AgentList active-marker — keep their contracts
  // unchanged.
  //
  // Initial pane comes from props.chatId: if the host has a persisted
  // chat id we open straight into Active with a placeholder agent (the
  // real agent name is filled in when ChatList loads, see onSelectChat).
  const [pane, setPane] = React.useState<PaneState>(() => {
    if (props.chatId) {
      const placeholder: ProtocolAgentListEntry = { name: "", description: "" };
      return { kind: "active", chatId: props.chatId, agent: placeholder };
    }
    return { kind: "idle" };
  });
  const activeChatId = pane.kind === "active" ? pane.chatId : null;
  const activeAgent =
    pane.kind === "idle" ? null : pane.agent.name || null;
  // Keep the local pane in sync if the host later pushes a new chatId
  // through props (e.g. on a leaf re-open after a restart).
  React.useEffect(() => {
    const id = props.chatId;
    if (!id) return;
    setPane((cur) => {
      if (cur.kind === "active" && cur.chatId === id) return cur;
      const agent: ProtocolAgentListEntry =
        cur.kind !== "idle" ? cur.agent : { name: "", description: "" };
      return { kind: "active", chatId: id, agent };
    });
  }, [props.chatId]);
  // Mirror of the older setActiveChatId imperative API so the host's
  // registerSetActiveChatId callback (used by the "open + mint" command)
  // keeps working. We don't know the agent here, so we carry whatever
  // the current pane already has — onSelectChat will refine when the
  // ChatList tells us the agent name.
  const setActiveChatId = React.useCallback((id: string) => {
    setPane((cur) => {
      const agent: ProtocolAgentListEntry =
        cur.kind !== "idle" ? cur.agent : { name: "", description: "" };
      return { kind: "active", chatId: id, agent };
    });
  }, []);

  // VOS-151: ref pinned to the composer textarea. Filled by ComposerPrimitive.Input
  // (which forwards to HTMLTextAreaElement). onSelect / onPickAgent call
  // focusComposerInputSafely so a chat-switch or agent-pick lands the cursor
  // in the message input without an extra click. Guard inside the helper
  // skips focus when an Obsidian modal/popover is open.
  const composerInputRef = React.useRef<HTMLTextAreaElement>(null);
  const focusComposer = React.useCallback(() => {
    focusComposerInputSafely(composerInputRef.current, document);
  }, []);

  // Expose an imperative setter so the host (ChatView / Obsidian command)
  // can push a freshly-minted chat id into this tree without remounting or
  // relying on prop diffing (props are computed once at mount via the deps
  // factory). Registered once on mount.
  const register = props.registerSetActiveChatId;
  React.useEffect(() => {
    register?.(setActiveChatId);
  }, [register]);

  // Bumped after every successful "+ New" or new-chat-id mint to force the
  // ChatList to re-fetch /chats. Cheap and predictable; avoids wiring the
  // FrameBus into the list for now.
  const [refreshKey, setRefreshKey] = React.useState(0);
  const bumpRefresh = React.useCallback(() => setRefreshKey((n) => n + 1), []);

  const [toast, setToast] = React.useState<{ id: number; text: string } | null>(null);
  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = React.useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToast({ id, text });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);
  React.useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const handle = useChatRuntime({
    bus: props.bus,
    api: props.api,
    chatId: activeChatId,
    defaultAgent: props.defaultAgent,
    onComposerToast: showToast,
    onChatIdMinted: async (id) => {
      setActiveChatId(id);
      await props.onChatIdMinted?.(id);
      bumpRefresh();
    },
  });
  const runtime = handle.runtime;

  const notifyAnswer409 = handle.notifyAnswer409;
  const askUserCtx: AskUserContextValue = React.useMemo(
    () => ({
      chatId: activeChatId,
      answer: (toolUseId, text) => props.api.answer(activeChatId ?? "", toolUseId, text),
      showToast,
      notifyAnswer409,
    }),
    [activeChatId, props.api, showToast, notifyAnswer409],
  );

  // Refresh chat list on run start AND any terminal frame. run.start updates
  // the sidebar status dot; run.end/run.error refreshes last_msg + clears the
  // dot. Debounced to ≥250ms to avoid network thrash when frames cluster.
  const lastListRefreshAtRef = React.useRef(0);
  const listRefreshTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedListRefresh = React.useCallback(() => {
    const DEBOUNCE_MS = 250;
    const now = Date.now();
    const since = now - lastListRefreshAtRef.current;
    if (since >= DEBOUNCE_MS) {
      lastListRefreshAtRef.current = now;
      bumpRefresh();
      return;
    }
    if (listRefreshTimerRef.current != null) return;
    listRefreshTimerRef.current = setTimeout(() => {
      lastListRefreshAtRef.current = Date.now();
      listRefreshTimerRef.current = null;
      bumpRefresh();
    }, DEBOUNCE_MS - since);
  }, [bumpRefresh]);
  React.useEffect(() => {
    const off = props.bus.on((f) => {
      if (
        f.type === "run.start" ||
        f.type === "run.end" ||
        f.type === "run.error" ||
        f.type === "chat.task.state_changed"
      ) {
        debouncedListRefresh();
      }
    });
    return () => {
      off();
      if (listRefreshTimerRef.current != null) {
        clearTimeout(listRefreshTimerRef.current);
        listRefreshTimerRef.current = null;
      }
    };
  }, [props.bus, debouncedListRefresh]);

  // Test-only hook: dispatch `vos-test-send` on window to drive the runtime's
  // append path under happy-dom (composer keyboard input is fragile there).
  // Gated behind NODE_ENV !== "production"; the plugin build (build.ts)
  // statically replaces process.env.NODE_ENV with "production", so the
  // listener is dead-code-eliminated by the minifier in the shipped bundle.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ text: string }>).detail;
      const text = detail?.text ?? "";
      if (!text) return;
      void runtime.thread.append({
        role: "user",
        content: [{ type: "text", text }],
      });
    };
    (globalThis as { window?: Window }).window?.addEventListener("vos-test-send", handler as EventListener);
    return () => {
      (globalThis as { window?: Window }).window?.removeEventListener("vos-test-send", handler as EventListener);
    };
  }, [runtime]);

  // VOS-153 T5: ChatRoot keeps its own snapshot of the agent list so
  // it can resolve `name → AgentListEntry` synchronously when the rail
  // calls onPickAgent (which only forwards the agent's name). The
  // AgentList rail still does its own fetch with a refreshKey for
  // rendering — duplicating the cheap GET /agents is preferable to
  // changing the rail's prop contract in this task's scope.
  const [agentsCache, setAgentsCache] = React.useState<ProtocolAgentListEntry[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    props.agentsApi
      .listAgents()
      .then((rows) => {
        if (cancelled) return;
        setAgentsCache(rows.map(widenAgent));
      })
      .catch(() => {
        // Silent: rail surfaces the daemon-offline state already.
      });
    return () => {
      cancelled = true;
    };
  }, [props.agentsApi, refreshKey]);

  const onNewChat = React.useMemo(
    () =>
      wireOnNewChat({
        api: props.api,
        openPicker: props.openPicker,
        onChatIdMinted: async (id, agentName) => {
          // Match pre-T5 behaviour: "+ New chat" sidebar button mints
          // the chat row eagerly and transitions straight to Active.
          const agent: ProtocolAgentListEntry =
            agentsCache.find((a) => a.name === agentName) ||
            { name: agentName || "", description: "" };
          setPane({ kind: "active", chatId: id, agent });
          await props.onChatIdMinted?.(id);
        },
        bumpRefresh,
        fallbackAgent: props.defaultAgent,
      }),
    [props.api, props.openPicker, props.onChatIdMinted, props.defaultAgent, bumpRefresh, agentsCache],
  );

  const onSelect = React.useCallback((id: string, agentName: string) => {
    const agent: ProtocolAgentListEntry =
      agentsCache.find((a) => a.name === agentName) ||
      { name: agentName || "", description: "" };
    setPane({ kind: "active", chatId: id, agent });
    focusComposer();
  }, [focusComposer, agentsCache]);

  // VOS-153 T5: agent-pick is a pure UI transition into Draft. No
  // daemon call, no chat row materialised. The chat is created on the
  // first send (see onDraftSend); on send failure it is deleted again.
  const onPickAgent = React.useCallback((name: string) => {
    const agent: ProtocolAgentListEntry =
      agentsCache.find((a) => a.name === name) ||
      { name, description: "" };
    setPane({ kind: "draft", agent });
    focusComposer();
  }, [agentsCache, focusComposer]);

  const [composerError, setComposerError] = React.useState<string | null>(null);

  // VOS-153 T5: atomic create-then-send with rollback. The composer
  // text is held in the assistant-ui store (clear closure passed in)
  // and only cleared on success. On createChat success but
  // postMessage failure, we DELETE the orphan chat row before
  // surfacing the error so the sidebar list stays clean.
  const onDraftSend = React.useCallback(
    async (text: string, clear: () => void) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Snapshot the agent so concurrent setPane during the in-flight
      // call cannot stomp the rollback target.
      if (pane.kind !== "draft") return;
      const agent: ProtocolAgentListEntry = pane.agent;
      setComposerError(null);
      let chatId: string | undefined;
      try {
        const created = await props.api.createChat(agent.name);
        chatId = created.id;
        await props.api.postMessage(chatId, text);
        setPane({ kind: "active", chatId, agent });
        await props.onChatIdMinted?.(chatId);
        bumpRefresh();
        clear();
        focusComposer();
      } catch (err) {
        if (chatId) {
          try {
            await props.api.deleteChat(chatId);
          } catch {
            // Orphan row left behind; T6 ribbon would flag this. For
            // T5 we just keep the operator in Draft with an error.
          }
        }
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "couldn't send — retry";
        setComposerError(msg);
        showToast(msg);
        // Stay in Draft; do NOT clear the composer so the user can retry.
      }
    },
    [pane, props.api, props.onChatIdMinted, bumpRefresh, showToast, focusComposer],
  );

  const childTaskCtx = React.useMemo(
    () => ({ chatState: handle.chatState, dispatch: handle.dispatch }),
    [handle.chatState, handle.dispatch],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AskUserContext.Provider value={askUserCtx}>
      <ChildTaskContext.Provider value={childTaskCtx}>
      {/* VOS-153 T5: outer wrapper carries the new `chat-root` testid
          while the inner `vos-chat-root` div keeps the legacy id for
          existing specs and helpers. Both are display:contents so
          neither participates in layout. */}
      <div data-testid="chat-root" data-pane-kind={pane.kind} className="vos:contents">
      <div data-testid="vos-chat-root" className="vos:contents">
      {/* Tool UI registration. `BashTool` is from makeAssistantToolUI — it
          renders nothing visible itself; its mount side-effect registers a
          renderer for toolName === "Bash" inside the assistant-ui store. */}
      <BashTool />
      <AskUserTool />
      <AskAgentTool />
      <div className="vos:flex vos:flex-row vos:h-full vos:w-full">
        <div className="vos:flex vos:flex-col vos:h-full vos:w-[260px] vos:shrink-0 vos:bg-[var(--background-secondary)]">
          <AgentList
            agentsApi={props.agentsApi}
            activeAgent={activeAgent}
            onPickAgent={onPickAgent}
            refreshKey={refreshKey}
          />
          <ChatList
            api={props.api}
            activeChatId={activeChatId}
            onSelect={onSelect}
            onNewChat={onNewChat}
            refreshKey={refreshKey}
          />
          <CostMeter api={props.api} refreshKey={refreshKey} />
        </div>
        <div className="vos:flex vos:flex-col vos:flex-1 vos:min-w-0 vos:min-h-0 vos:h-full">
          {/* VOS-153 T5: Idle and Draft branches. The Active branch
              keeps the existing ThreadPrimitive.Root subtree below so
              the runtime, ask_user wiring, queued-send button etc. all
              remain wired exactly as before. */}
          {pane.kind === "idle" && (
            <div
              data-testid="chat-empty"
              className="void-os-chat-empty vos:flex vos:flex-1 vos:items-center vos:justify-center vos:text-sm vos:text-[var(--text-muted)] vos:p-[var(--size-4-4)]"
            >
              <p>← pick an agent or chat from the sidebar</p>
            </div>
          )}
          {pane.kind === "draft" && (
            <div
              data-testid="chat-draft"
              data-agent={pane.agent.name}
              className="void-os-chat-draft vos:flex vos:flex-col vos:flex-1 vos:min-h-0"
            >
              <div className="vos:flex-1 vos:overflow-y-auto vos:flex vos:flex-col">
                <div className="vos:mt-auto vos:w-full vos:max-w-[760px] vos:mx-auto vos:px-[var(--size-4-4)] vos:py-[var(--size-4-3)] vos:flex vos:flex-col">
                  <DraftLabel agent={pane.agent} />
                </div>
              </div>
              <div className="vos:shrink-0 vos:w-full vos:max-w-[760px] vos:mx-auto vos:px-[var(--size-4-4)]">
                {composerError && (
                  <div
                    data-testid="composer-error"
                    className="vos:mt-[var(--size-4-2)] vos:mb-[var(--size-4-1)] vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:rounded-[var(--radius-s)] vos:bg-[var(--background-modifier-error,#a0303d)] vos:text-[var(--text-on-accent)] vos:text-xs"
                  >
                    {composerError}
                  </div>
                )}
                <DraftComposer
                  composerInputRef={composerInputRef}
                  onSend={onDraftSend}
                />
              </div>
            </div>
          )}
          {pane.kind === "active" && (
          <div
            data-testid="chat-active"
            data-agent={pane.agent.name}
            className="void-os-chat-active vos:flex vos:flex-col vos:flex-1 vos:min-h-0"
          >
          {/* VOS-153 T5: minimal inline ChatHeader placeholder.
              T7 replaces this with a real component without
              changing the testid contract. */}
          <div
            data-testid="chat-header"
            data-agent={pane.agent.name}
            className="vos:shrink-0 vos:flex vos:items-center vos:gap-[var(--size-4-2)] vos:px-[var(--size-4-4)] vos:py-[var(--size-4-2)] vos:border-b vos:border-[var(--background-modifier-border)] vos:text-[13px] vos:text-[var(--text-normal)]"
          >
            {pane.agent.avatar && (
              <span className="vos:text-[14px] vos:leading-none">
                {pane.agent.avatar}
              </span>
            )}
            <span className="vos:font-semibold">{pane.agent.name}</span>
            {pane.agent.description && (
              <span className="vos:text-[var(--text-muted)] vos:text-[12px]">
                — {pane.agent.description}
              </span>
            )}
          </div>
          <ThreadPrimitive.Root className="vos:contents">
            <ThreadPrimitive.Viewport className="vos:flex-1 vos:overflow-y-auto vos:min-h-0 vos:flex vos:flex-col">
              <div className="vos:mt-auto vos:w-full vos:max-w-[760px] vos:mx-auto vos:px-[var(--size-4-4)] vos:py-[var(--size-4-3)] vos:flex vos:flex-col">
                <ThreadPrimitive.Messages components={{ Message: MessageItem }} />
                <ThinkingIndicator />
              </div>
            </ThreadPrimitive.Viewport>
            {/* shrink-0: composer must never collapse under tight space —
                otherwise a tall message list (or any layout quirk in the
                parent flex-col context) can starve the composer of height
                and make the textarea unfocusable. Regression caught in S5
                after the sidebar restructure changed the flex graph. */}
            <ComposerKeyboardHandler
              className="vos:shrink-0 vos:w-full vos:max-w-[760px] vos:mx-auto vos:px-[var(--size-4-4)]"
              isRunning={handle.isRunning}
              pendingAskUserButtonsOnly={
                handle.pendingAskUser !== null &&
                (handle.pendingAskUser.options?.length ?? 0) > 0
              }
              send={handle.send}
              cancel={handle.cancel}
            >
              {handle.pendingAskUser && (() => {
                const isButtonsOnly = (handle.pendingAskUser.options?.length ?? 0) > 0;
                const question = handle.pendingAskUser.question || "";
                const truncated =
                  question.length > 80 ? question.slice(0, 77) + "…" : question;
                return (
                  <div
                    data-testid="ask-user-banner"
                    data-banner-mode={isButtonsOnly ? "blocked" : "answer"}
                    className="vos:mt-[var(--size-4-2)] vos:mb-[var(--size-4-1)] vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:rounded-[var(--radius-s)] vos:bg-[var(--background-secondary)] vos:text-xs vos:text-[var(--text-muted)] vos:border vos:border-[var(--background-modifier-border)]"
                  >
                    {isButtonsOnly
                      ? "Pick one of the options above to continue."
                      : `Answering: ${truncated}`}
                  </div>
                );
              })()}
              <ComposerPrimitive.Root
                className="vos:flex vos:items-end vos:gap-[var(--size-4-2)] vos:my-[var(--size-4-3)] vos:p-[var(--size-4-2)] vos:rounded-[var(--radius-m)] vos:border vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-primary)] focus-within:vos:border-[var(--interactive-accent)] focus-within:vos:shadow-[0_0_0_1px_var(--interactive-accent)]"
              >
                <ComposerPrimitive.Input
                  ref={composerInputRef}
                  rows={1}
                  autoFocus
                  placeholder={
                    handle.pendingAskUser && !handle.pendingAskUser.options?.length
                      ? "Type your answer…"
                      : handle.pendingAskUser
                      ? "Use the buttons above"
                      : "Message"
                  }
                  disabled={
                    handle.pendingAskUser !== null &&
                    (handle.pendingAskUser.options?.length ?? 0) > 0
                  }
                  data-testid={
                    handle.pendingAskUser && !(handle.pendingAskUser.options?.length)
                      ? "ask-user-composer"
                      : undefined
                  }
                  className="vos:flex-1 vos:bg-transparent vos:resize-none vos:outline-none vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:text-[var(--text-normal)] placeholder:vos:text-[var(--text-muted)] disabled:vos:opacity-50"
                />
                {(() => {
                  const inButtonsOnly =
                    handle.pendingAskUser !== null &&
                    (handle.pendingAskUser.options?.length ?? 0) > 0;
                  if (inButtonsOnly) return null;
                  if (handle.isRunning) return <QueueSendButton send={handle.send} />;
                  return (
                    <ComposerPrimitive.Send
                      className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-1)] vos:rounded-[var(--radius-s)] vos:bg-[var(--interactive-accent)] vos:text-[var(--text-on-accent)] vos:border vos:border-transparent hover:vos:bg-[var(--interactive-accent-hover)] disabled:vos:bg-[var(--background-modifier-form-field)] disabled:vos:text-[var(--text-faint)] disabled:vos:cursor-not-allowed"
                    >
                      Send
                    </ComposerPrimitive.Send>
                  );
                })()}
              </ComposerPrimitive.Root>
              {handle.isRunning && (
                <div
                  data-testid="esc-hint"
                  className="vos:mb-[var(--size-4-3)] vos:px-[var(--size-4-2)] vos:text-[11px] vos:text-[var(--text-muted)] vos:leading-none"
                >
                  ESC to interrupt
                </div>
              )}
              {toast && (
                <div
                  key={toast.id}
                  data-testid="ask-user-toast"
                  className="vos:mb-[var(--size-4-2)] vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:rounded-[var(--radius-s)] vos:bg-[var(--background-modifier-error,#a0303d)] vos:text-[var(--text-on-accent)] vos:text-xs vos:inline-block"
                >
                  {toast.text}
                </div>
              )}
            </ComposerKeyboardHandler>
          </ThreadPrimitive.Root>
          </div>
          )}
        </div>
      </div>
      </div>
      </div>
      </ChildTaskContext.Provider>
      </AskUserContext.Provider>
    </AssistantRuntimeProvider>
  );
}

// VOS-153 T5: Draft-pane composer. Keeps the visual shape of the
// Active composer (rounded card, focus ring) but does NOT consume the
// assistant-ui thread — there is no chat row yet. Enter and the Send
// button both call `onSend(text, clear)`; clearing the input is the
// caller's responsibility on success only (so failed sends preserve
// the user's text for retry).
function DraftComposer(props: {
  composerInputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string, clear: () => void) => Promise<void> | void;
}) {
  const [text, setText] = React.useState("");
  const clear = React.useCallback(() => setText(""), []);
  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.nativeEvent.isComposing !== true
      ) {
        if (!text.trim()) return;
        e.preventDefault();
        void props.onSend(text, clear);
      }
    },
    [text, clear, props],
  );
  const onClickSend = React.useCallback(() => {
    if (!text.trim()) return;
    void props.onSend(text, clear);
  }, [text, clear, props]);
  return (
    <div
      className="vos:flex vos:items-end vos:gap-[var(--size-4-2)] vos:my-[var(--size-4-3)] vos:p-[var(--size-4-2)] vos:rounded-[var(--radius-m)] vos:border vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-primary)] focus-within:vos:border-[var(--interactive-accent)] focus-within:vos:shadow-[0_0_0_1px_var(--interactive-accent)]"
    >
      <textarea
        ref={props.composerInputRef}
        rows={1}
        autoFocus
        placeholder="Message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        data-testid="draft-composer"
        className="vos:flex-1 vos:bg-transparent vos:resize-none vos:outline-none vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:text-[var(--text-normal)] placeholder:vos:text-[var(--text-muted)]"
      />
      <button
        type="button"
        data-testid="draft-send"
        onClick={onClickSend}
        disabled={!text.trim()}
        className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-1)] vos:rounded-[var(--radius-s)] vos:bg-[var(--interactive-accent)] vos:text-[var(--text-on-accent)] vos:border vos:border-transparent hover:vos:bg-[var(--interactive-accent-hover)] disabled:vos:bg-[var(--background-modifier-form-field)] disabled:vos:text-[var(--text-faint)] disabled:vos:cursor-not-allowed"
      >
        Send
      </button>
    </div>
  );
}
