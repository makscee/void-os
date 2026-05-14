import { ItemView, type WorkspaceLeaf } from "obsidian";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatRoot } from "./chat/ChatRoot";

export const CHAT_VIEW_TYPE = "void-os-chat";

export class ChatView extends ItemView {
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return "void-os chat"; }
  getIcon() { return "message-circle"; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    const mount = container.createDiv({ cls: "void-os-chat-root" });
    this.root = createRoot(mount);
    this.root.render(React.createElement(ChatRoot));
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
