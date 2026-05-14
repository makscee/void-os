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
    <MessagePrimitive.Root className="vos:py-2">
      <MessagePrimitive.Parts components={{ Text: TextPart }} />
    </MessagePrimitive.Root>
  );
}

export function ChatRoot(props: ChatRootProps) {
  const runtime = useChatRuntime(props);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="vos:flex vos:flex-col vos:h-full vos:w-full">
        <ThreadPrimitive.Root className="vos:flex vos:flex-col vos:h-full">
          <ThreadPrimitive.Viewport className="vos:flex-1 vos:overflow-y-auto vos:px-4 vos:py-2">
            <ThreadPrimitive.Empty>
              <div className="vos:text-sm vos:opacity-60 vos:p-4">
                void-os chat — say hi.
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ Message: MessageItem }} />
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="vos:flex vos:items-end vos:gap-2 vos:border-t vos:p-2">
            <ComposerPrimitive.Input
              rows={1}
              autoFocus
              placeholder="Message"
              className="vos:flex-1 vos:bg-transparent vos:resize-none vos:outline-none vos:px-2 vos:py-1"
            />
            <ComposerPrimitive.Send
              className="vos:px-3 vos:py-1 vos:rounded vos:border vos:opacity-100"
            >
              Send
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
