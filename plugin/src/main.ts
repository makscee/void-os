import { Plugin, type WorkspaceLeaf } from "obsidian";
import { ChatView, CHAT_VIEW_TYPE } from "./view";
import { WsClient } from "./ws-client";
import { ReconnectFSM } from "./reconnect";
import { StatusBar } from "./status";

const DAEMON_URL = "ws://127.0.0.1:7777/events";
const RETRY_MS = 2000;
const PING_MS = 10000;
const PONG_TIMEOUT_MS = 25000;

export default class VoidOsPlugin extends Plugin {
  private fsm: ReconnectFSM | null = null;

  async onload() {
    this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ChatView(leaf));

    const statusBar = new StatusBar(this.addStatusBarItem());
    const wsClient = new WsClient(DAEMON_URL);
    this.fsm = new ReconnectFSM({
      client: wsClient,
      onState: (s) => statusBar.update(s),
      retryMs: RETRY_MS,
      pingMs: PING_MS,
      pongTimeoutMs: PONG_TIMEOUT_MS,
    });
    this.fsm.start();

    this.addCommand({
      id: "open-chat-view",
      name: "Open void-os chat",
      callback: () => this.activateChatView(),
    });
  }

  async onunload() {
    this.fsm?.stop();
    this.fsm = null;
  }

  private async activateChatView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
