// React context plumbing for the inline `ask_user` tool render. ChatRoot
// supplies the live value (chatId + answer() bound to ChatApi). AskUserTool
// consumes it because assistant-ui's tool render fn does not receive runtime
// deps directly.

import * as React from "react";

export interface AskUserContextValue {
  chatId: string | null;
  /** Resolves the open ask_user prompt. Tagged result so callers branch:
   *  `{ok:true}` → daemon accepted; `{ok:false, status:409, ...}` → race recovery. */
  answer(toolUseId: string, text: string): Promise<
    | { ok: true }
    | { ok: false; status: 400 | 404 | 409; error: string }
  >;
  /** Surface a transient toast in the chat surface. Toast layer lives in ChatRoot;
   *  AskUserTool calls this on error paths (network failure). */
  showToast(text: string): void;
  /** Notify the runtime that an /answer call returned 409 (another tab /
   *  resolution already won the race). AskUserTool calls this so the
   *  reducer clears `pendingAskUser` and the banner detaches even before
   *  the daemon's tool_result frame echoes through. VOS-90 T8. */
  notifyAnswer409(): void;
}

const noopValue: AskUserContextValue = {
  chatId: null,
  async answer() { return { ok: true }; },
  showToast() {},
  notifyAnswer409() {},
};

export const AskUserContext = React.createContext<AskUserContextValue>(noopValue);
