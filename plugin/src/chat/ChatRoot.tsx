import * as React from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
} from "@assistant-ui/react";

import type { FrameBus } from "./bus";
import type { ChatApi } from "./api";
import { useChatRuntime } from "./runtime";

export interface ChatRootProps {
  bus: FrameBus;
  api: ChatApi;
  chatId: string | null;
  onChatIdMinted?: (id: string) => void | Promise<void>;
  defaultAgent?: string;
}

// MessagePrimitive.Parts wants a `FunctionComponent<TextMessagePart>` for Text;
// MessagePartPrimitive.Text is a forwardRef HTMLSpan primitive. Wrap it.
const TextPart = () => <MessagePartPrimitive.Text />;

function MessageItem() {
  return (
    <MessagePrimitive.Root className="vos:w-full vos:my-3 vos:flex vos:flex-col">
      {/* User: right-aligned tinted bubble */}
      <MessagePrimitive.If user>
        <div className="vos:flex vos:justify-end">
          <div
            className="vos:max-w-[85%] vos:rounded-lg vos:px-3 vos:py-2 vos:bg-[var(--background-secondary)] vos:text-[var(--text-normal)] vos:whitespace-pre-wrap vos:leading-relaxed"
          >
            <MessagePrimitive.Parts components={{ Text: TextPart }} />
          </div>
        </div>
      </MessagePrimitive.If>
      {/* Assistant: full-width, left-edge accent, no bg */}
      <MessagePrimitive.If assistant>
        <div className="vos:flex vos:flex-col vos:gap-1">
          <div className="vos:text-[11px] vos:uppercase vos:tracking-wider vos:text-[var(--text-muted)]">
            assistant
          </div>
          <div
            className="vos:border-l-2 vos:border-[var(--interactive-accent)] vos:pl-3 vos:text-[var(--text-normal)] vos:whitespace-pre-wrap vos:leading-relaxed"
          >
            <MessagePrimitive.Parts components={{ Text: TextPart }} />
          </div>
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
      <div className="vos:w-full vos:my-3 vos:flex vos:flex-col vos:gap-1">
        <div className="vos:border-l-2 vos:border-[var(--interactive-accent)] vos:pl-3">
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
  const runtime = useChatRuntime(props);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="vos:flex vos:flex-col vos:h-full vos:w-full">
        <ThreadPrimitive.Root className="vos:flex vos:flex-col vos:h-full">
          <ThreadPrimitive.Viewport className="vos:flex-1 vos:overflow-y-auto vos:px-4 vos:py-3">
            <ThreadPrimitive.Empty>
              <div className="vos:text-sm vos:text-[var(--text-muted)] vos:p-4">
                void-os chat — say hi.
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ Message: MessageItem }} />
            <ThinkingIndicator />
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root
            className="vos:flex vos:items-end vos:gap-2 vos:m-2 vos:p-2 vos:rounded vos:border vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-primary)] focus-within:vos:border-[var(--interactive-accent)] focus-within:vos:ring-1 focus-within:vos:ring-[var(--interactive-accent)]"
          >
            <ComposerPrimitive.Input
              rows={1}
              autoFocus
              placeholder="Message"
              className="vos:flex-1 vos:bg-transparent vos:resize-none vos:outline-none vos:px-2 vos:py-1 vos:text-[var(--text-normal)] placeholder:vos:text-[var(--text-muted)]"
            />
            <ComposerPrimitive.Send
              className="vos:px-3 vos:py-1 vos:rounded vos:bg-[var(--interactive-accent)] vos:text-[var(--text-on-accent)] vos:border vos:border-transparent disabled:vos:bg-[var(--background-modifier-hover)] disabled:vos:text-[var(--text-muted)] disabled:vos:cursor-not-allowed"
            >
              Send
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
