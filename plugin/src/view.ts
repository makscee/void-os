import { ItemView, type WorkspaceLeaf } from "obsidian";

export const CHAT_VIEW_TYPE = "void-os-chat";

export class ChatView extends ItemView {
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return "void-os chat"; }
  getIcon() { return "message-circle"; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.createDiv({ cls: "void-os-chat-root" });
    // empty container — message UI lands in the next task
  }

  async onClose() { /* noop */ }
}
