// Context that threads ChatState + dispatch into child-task tool components.
// Mounted once by ChatRoot, read by AskAgentTool via makeAssistantToolUI.
// Pattern mirrors AskUserContext (VOS-90).

import * as React from "react";
import type { ChatState, LocalAction } from "./reducer";

export interface ChildTaskContextValue {
  chatState: ChatState;
  dispatch: React.Dispatch<LocalAction>;
}

const noop = () => {};

export const ChildTaskContext = React.createContext<ChildTaskContextValue>({
  chatState: {
    chatId: null,
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
  },
  dispatch: noop,
});
