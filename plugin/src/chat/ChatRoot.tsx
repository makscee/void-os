import * as React from "react";
import { useState, useCallback } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { AppendMessage } from "@assistant-ui/react";

/**
 * S1 no-op runtime: keeps an empty message list and ignores send.
 * S2 will replace this with the daemon WS adapter (see VOS-80 plan).
 */
function useNoopRuntime() {
  const [messages] = useState<ThreadMessageLike[]>([]);
  const onNew = useCallback(async (_msg: AppendMessage) => {
    // intentionally a no-op for S1 — daemon wiring in S2
  }, []);
  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: false,
    isSendDisabled: true, // disable send button per S1 acceptance
    onNew,
    convertMessage: (m) => m,
  });
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

export function ChatRoot() {
  const runtime = useNoopRuntime();
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="vos:flex vos:flex-col vos:h-full vos:w-full">
        <ThreadPrimitive.Root className="vos:flex vos:flex-col vos:h-full">
          <ThreadPrimitive.Viewport className="vos:flex-1 vos:overflow-y-auto vos:px-4 vos:py-2">
            <ThreadPrimitive.Empty>
              <div className="vos:text-sm vos:opacity-60 vos:p-4">
                void-os chat — daemon wiring lands in S2.
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ Message: MessageItem }} />
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="vos:flex vos:items-end vos:gap-2 vos:border-t vos:p-2">
            <ComposerPrimitive.Input
              rows={1}
              autoFocus
              placeholder="Message (disabled — S2)"
              className="vos:flex-1 vos:bg-transparent vos:resize-none vos:outline-none vos:px-2 vos:py-1"
            />
            <ComposerPrimitive.Send
              disabled
              className="vos:px-3 vos:py-1 vos:rounded vos:border vos:opacity-50"
            >
              Send
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
