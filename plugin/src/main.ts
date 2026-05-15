import { Plugin, requestUrl, type WorkspaceLeaf } from "obsidian";
import { ChatView, CHAT_VIEW_TYPE } from "./view";
import { WsClient, type WsEvent, type WsPort } from "./ws-client";
import { ReconnectFSM } from "./reconnect";
import { StatusBar } from "./status";
import { FrameBus, type DaemonFrame } from "./chat/bus";
import { makeChatApi } from "./chat/api";
import { makeSettingsStore, type SettingsStore } from "./chat/settings";
import { makeAgentsApi } from "./agents/api";
import { openAgentPicker, makeRealAgentPickerFactory, defaultOnError } from "./agents/picker";
import type { AgentListEntry } from "./agents/types";

/** Adapt Obsidian's `requestUrl` (Electron main-process HTTP, no CORS) to the
 *  `fetch`-shaped seam consumed by makeChatApi.
 *
 *  Why: the Obsidian renderer enforces browser CORS; the daemon is local-only
 *  and (intentionally) does not emit Access-Control-Allow-Origin headers, so
 *  any preflighted POST from the renderer is rejected. requestUrl bypasses
 *  this because it runs out-of-process.
 *
 *  Only the surface our ChatApi actually touches is implemented:
 *  - method, headers (lowercased keys), body (string)
 *  - response.ok, response.status, response.text()
 */
function requestUrlAsFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    const contentType = headers["content-type"];
    const body = typeof init?.body === "string" ? init.body : undefined;

    const r = await requestUrl({
      url,
      method,
      headers,
      contentType,
      body,
      throw: false,
    });

    const text = r.text ?? "";
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
}

const DAEMON_HTTP = "http://127.0.0.1:7777";
const DAEMON_WS = "ws://127.0.0.1:7777/events";
const RETRY_MS = 2000;
const PING_MS = 10000;
const PONG_TIMEOUT_MS = 25000;

/** Wraps a WsPort so a single underlying handler is multiplexed:
 *  - the original consumer (ReconnectFSM) sees every event verbatim;
 *  - frame events are also fanned out to the FrameBus for chat consumers.
 *
 *  The WsClient surface (single .on()) stays untouched, which keeps the
 *  existing FSM + ws-client tests stable.
 */
function tapFrames(client: WsPort, bus: FrameBus): WsPort {
  return {
    open: () => client.open(),
    close: () => client.close(),
    send: (f) => client.send(f),
    on(handler: (e: WsEvent) => void) {
      client.on((e) => {
        handler(e);
        if (e.kind === "frame" && e.data && typeof e.data === "object") {
          const frame = e.data as DaemonFrame;
          if (typeof frame.type === "string") bus.emit(frame);
        }
      });
    },
  };
}

export default class VoidOsPlugin extends Plugin {
  private fsm: ReconnectFSM | null = null;
  private bus: FrameBus | null = null;
  private settings: SettingsStore | null = null;

  async onload() {
    this.settings = await makeSettingsStore({
      loadData: () => this.loadData(),
      saveData: (d) => this.saveData(d),
    });
    this.bus = new FrameBus();
    const api = makeChatApi(DAEMON_HTTP, requestUrlAsFetch());
    const agentsApi = makeAgentsApi(DAEMON_HTTP, requestUrlAsFetch());
    const pickerFactory = makeRealAgentPickerFactory(this.app);

    const openPicker = (): Promise<AgentListEntry | null> =>
      openAgentPicker({
        agentsApi,
        modalFactory: pickerFactory,
        onError: defaultOnError,
      });

    // Single WebSocket — FSM owns reconnect, FrameBus piggybacks on frames.
    const wsClient = new WsClient(DAEMON_WS);
    const tapped = tapFrames(wsClient, this.bus);

    this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
      new ChatView(leaf, () => ({
        bus: this.bus!,
        api,
        chatId: this.settings!.get().chatId,
        onChatIdMinted: (id) => this.settings!.setChatId(id),
        defaultAgent: "maya", // retained as fallback only
        openPicker,
      })),
    );

    const statusBar = new StatusBar(this.addStatusBarItem());
    this.fsm = new ReconnectFSM({
      client: tapped,
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

    this.addCommand({
      id: "new-chat-with-agent",
      name: "New chat with agent…",
      callback: async () => {
        const picked = await openPicker();
        if (!picked) return;
        await this.activateChatView();
        const created = await api.createChat(picked.name);
        this.settings!.setChatId(created.id);
        // ChatView re-reads chatId from settings on focus; next user message
        // opens the chat via the existing path.
      },
    });
  }

  async onunload() {
    this.fsm?.stop();
    this.fsm = null;
    this.bus = null;
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
