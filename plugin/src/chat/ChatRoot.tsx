import * as React from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

import type { FrameBus } from "./bus";
import type { ChatApi } from "./api";
import { useChatRuntime } from "./runtime";
import { ChatList } from "./ChatList";
import { CostMeter } from "./CostMeter";
import { BashTool } from "./tools/BashTool";
import { GenericTool } from "./tools/GenericTool";

export interface ChatRootProps {
  bus: FrameBus;
  api: ChatApi;
  chatId: string | null;
  onChatIdMinted?: (id: string) => void | Promise<void>;
  defaultAgent?: string;
}

// MessagePrimitive.Parts wants a `FunctionComponent<TextMessagePart>` for Text;
// MessagePartPrimitive.Text is a forwardRef HTMLSpan primitive. Wrap it.
// Used for user messages — they're plain text, no markdown rendering needed.
const TextPart = () => <MessagePartPrimitive.Text />;

// Assistant Text part: render markdown. `MarkdownTextPrimitive` reads the
// current part's text via assistant-ui context, so no props need forwarding.
// `vos-md` scopes our markdown CSS to this wrapper only.
const MarkdownText = () => (
  <MarkdownTextPrimitive className="vos-md" smooth={false} />
);

function MessageItem() {
  return (
    <MessagePrimitive.Root className="vos:w-full vos:my-[var(--size-4-2)] vos:flex vos:flex-col vos-fade-in">
      {/* User: right-aligned tinted bubble */}
      <MessagePrimitive.If user>
        <div className="vos:flex vos:justify-end">
          <div
            className="vos:max-w-[85%] vos:rounded-[var(--radius-m)] vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:bg-[var(--background-secondary)] vos:text-[var(--text-normal)] vos:whitespace-pre-wrap vos:leading-relaxed"
          >
            <MessagePrimitive.Parts components={{ Text: TextPart }} />
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
            }}
          />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

// Three-dot thinking indicator. Visible whenever the thread is running.
// Approach: always render the dots while running. If the assistant has not
// begun streaming, the dots sit alone below the user's last message. Once
// a partial assistant message exists, the dots sit beneath the streaming
// bubble as a "still working" pulse — the streaming text itself is the
// primary signal, dots are secondary. This avoids needing to inspect the
// last-message role from outside the messages list.
function ThinkingIndicator() {
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

export function ChatRoot(props: ChatRootProps) {
  // Lift active chat into local state so the list can switch chats without
  // a remount of the leaf. Initial value comes from the persisted setting
  // (props.chatId). When the parent later passes a different `props.chatId`
  // (e.g. fresh open after restart), we sync it down.
  const [activeChatId, setActiveChatId] = React.useState<string | null>(props.chatId);
  React.useEffect(() => { setActiveChatId(props.chatId); }, [props.chatId]);

  // Bumped after every successful "+ New" or new-chat-id mint to force the
  // ChatList to re-fetch /chats. Cheap and predictable; avoids wiring the
  // FrameBus into the list for now.
  const [refreshKey, setRefreshKey] = React.useState(0);
  const bumpRefresh = React.useCallback(() => setRefreshKey((n) => n + 1), []);

  // Inline "run in progress" notice — set when a send returns 409 from the
  // daemon (another run is already streaming for this chat). Auto-clears on
  // run.end/run.error for the active chat, on chat switch, and on next
  // successful send (reset just before postMessage in onSendError handler).
  const [runInProgressNotice, setRunInProgressNotice] = React.useState(false);

  const runtime = useChatRuntime({
    bus: props.bus,
    api: props.api,
    chatId: activeChatId,
    defaultAgent: props.defaultAgent,
    onChatIdMinted: async (id) => {
      setActiveChatId(id);
      await props.onChatIdMinted?.(id);
      bumpRefresh();
    },
    onSendError: (_chatId, err) => {
      // assistant-ui's ApiError carries `.status`. Duck-type to avoid the
      // import cycle (api.ts is already imported via runtime; we don't want
      // to bring the class into ChatRoot just for instanceof).
      const status = (err as { status?: number })?.status;
      if (status === 409) setRunInProgressNotice(true);
    },
  });

  // Refresh chat list whenever a run terminates so last_msg / status update.
  // Also clear the 409 notice — if the other run finished, send is safe.
  React.useEffect(() => {
    const off = props.bus.on((f) => {
      if (f.type === "run.end" || f.type === "run.error") {
        bumpRefresh();
        if (f.chat_id === activeChatId) setRunInProgressNotice(false);
      }
    });
    return off;
  }, [props.bus, bumpRefresh, activeChatId]);

  // Clear notice when the user switches chats — it's keyed on the active one.
  React.useEffect(() => {
    setRunInProgressNotice(false);
  }, [activeChatId]);

  // Test hook: dispatch `vos-test-send` on window to drive the runtime's
  // append path under happy-dom (composer keyboard input is fragile there).
  // No-op in production unless the event is fired.
  React.useEffect(() => {
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

  const onNewChat = React.useCallback(async () => {
    const created = await props.api.createChat(props.defaultAgent);
    setActiveChatId(created.id);
    await props.onChatIdMinted?.(created.id);
    bumpRefresh();
  }, [props.api, props.defaultAgent, props.onChatIdMinted, bumpRefresh]);

  const onSelect = React.useCallback((id: string) => {
    setActiveChatId(id);
  }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Tool UI registration. `BashTool` is from makeAssistantToolUI — it
          renders nothing visible itself; its mount side-effect registers a
          renderer for toolName === "Bash" inside the assistant-ui store. */}
      <BashTool />
      <div className="vos:flex vos:flex-row vos:h-full vos:w-full">
        <div className="vos:flex vos:flex-col vos:h-full vos:w-[260px] vos:shrink-0 vos:bg-[var(--background-secondary)]">
          <ChatList
            api={props.api}
            activeChatId={activeChatId}
            onSelect={onSelect}
            onNewChat={onNewChat}
            refreshKey={refreshKey}
          />
          <CostMeter />
        </div>
        <div className="vos:flex vos:flex-col vos:flex-1 vos:min-w-0 vos:min-h-0 vos:h-full">
          <ThreadPrimitive.Root className="vos:contents">
            <ThreadPrimitive.Viewport className="vos:flex-1 vos:overflow-y-auto vos:min-h-0 vos:flex vos:flex-col">
              <div className="vos:mt-auto vos:w-full vos:max-w-[760px] vos:mx-auto vos:px-[var(--size-4-4)] vos:py-[var(--size-4-3)] vos:flex vos:flex-col">
                <ThreadPrimitive.Empty>
                  <div className="vos:text-sm vos:text-[var(--text-muted)] vos:p-4">
                    void-os chat — say hi.
                  </div>
                </ThreadPrimitive.Empty>
                <ThreadPrimitive.Messages components={{ Message: MessageItem }} />
                <ThinkingIndicator />
              </div>
            </ThreadPrimitive.Viewport>
            {/* shrink-0: composer must never collapse under tight space —
                otherwise a tall message list (or any layout quirk in the
                parent flex-col context) can starve the composer of height
                and make the textarea unfocusable. Regression caught in S5
                after the sidebar restructure changed the flex graph. */}
            <div className="vos:shrink-0 vos:w-full vos:max-w-[760px] vos:mx-auto vos:px-[var(--size-4-4)]">
              <ComposerPrimitive.Root
                className="vos:flex vos:items-end vos:gap-[var(--size-4-2)] vos:my-[var(--size-4-3)] vos:p-[var(--size-4-2)] vos:rounded-[var(--radius-m)] vos:border vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-primary)] focus-within:vos:border-[var(--interactive-accent)] focus-within:vos:shadow-[0_0_0_1px_var(--interactive-accent)]"
              >
                <ComposerPrimitive.Input
                  rows={1}
                  autoFocus
                  placeholder="Message"
                  className="vos:flex-1 vos:bg-transparent vos:resize-none vos:outline-none vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:text-[var(--text-normal)] placeholder:vos:text-[var(--text-muted)]"
                />
                <ComposerPrimitive.Send
                  className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-1)] vos:rounded-[var(--radius-s)] vos:bg-[var(--interactive-accent)] vos:text-[var(--text-on-accent)] vos:border vos:border-transparent hover:vos:bg-[var(--interactive-accent-hover)] disabled:vos:bg-[var(--background-modifier-form-field)] disabled:vos:text-[var(--text-faint)] disabled:vos:cursor-not-allowed"
                >
                  Send
                </ComposerPrimitive.Send>
              </ComposerPrimitive.Root>
              {runInProgressNotice && (
                <div
                  data-testid="run-in-progress-notice"
                  className="vos:mb-[var(--size-4-3)] vos:border-l-2 vos:border-[var(--text-error,#e35a5a)] vos:pl-[var(--size-4-3)] vos:py-[var(--size-4-1)] vos:text-xs vos:text-[var(--text-muted)]"
                >
                  Run in progress — wait or cancel
                </div>
              )}
            </div>
          </ThreadPrimitive.Root>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
