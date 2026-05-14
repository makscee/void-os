import { ItemView, type WorkspaceLeaf } from "obsidian";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatRoot, type ChatRootProps } from "./chat/ChatRoot";

export const CHAT_VIEW_TYPE = "void-os-chat";

/** Late-bound deps so view-level state always reads the latest plugin state
 *  (e.g. chatId after first mint) without React provider gymnastics. */
export type ChatViewDeps = () => ChatRootProps;

export class ChatView extends ItemView {
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private deps: ChatViewDeps | null = null) {
    super(leaf);
  }
  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return "void-os chat"; }
  getIcon() { return "message-circle"; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    const mount = container.createDiv({ cls: "void-os-chat-root" });
    this.root = createRoot(mount);
    if (this.deps) {
      this.root.render(React.createElement(ChatRoot, this.deps()));
    } else {
      // Fallback for the smoke test: render an empty placeholder so onOpen
      // doesn't blow up when no deps are wired (test asserts mount exists).
      this.root.render(React.createElement("div", null));
    }
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
