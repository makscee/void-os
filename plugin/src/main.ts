import { Notice, Plugin, requestUrl, type WorkspaceLeaf } from "obsidian";
import { homedir } from "node:os";
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
import { VoidOsSettingsTab } from "./settings-tab";
import { DEFAULT_RETRY_MS, DEFAULT_PING_MS, DEFAULT_PONG_TIMEOUT_MS } from "./config.ts";
import {
  ensureDaemon,
  makeProductionProbe,
  makeProductionSpawn,
  resolveBinary,
  BinaryNotFoundError,
  VaultMismatchError,
  SpawnError,
  UnsupportedPlatformError,
  type DaemonAttachment,
} from "./daemon-lifecycle";
import { getVaultRoot } from "./vault-root";

/** Lifecycle-phase status published on the Plugin instance. Surfaced by the
 *  settings tab (T8) and by E2E specs (T9) so they can assert the plugin's
 *  view of the daemon without polling the HTTP layer directly. */
export type DaemonStatus =
  | { state: "running"; port: number; vault: string; version: string }
  | { state: "binary-missing" }
  | { state: "vault-mismatch"; activeVault: string }
  | { state: "spawn-failed"; error: string }
  | { state: "daemon-died" };

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

/** Build the http+ws origins the plugin talks to from a successful daemon
 *  attachment. The attachment's port wins over `settings.daemonUrl` — the
 *  ensureDaemon contract is that whatever it returned is what's actually
 *  listening locally. The legacy `daemonUrl` setting remains in the schema
 *  for migration, but is no longer consulted at the wire layer. */
function urlsFromAttachment(att: DaemonAttachment): { http: string; ws: string } {
  const http = `http://127.0.0.1:${att.port}`;
  const ws = `ws://127.0.0.1:${att.port}/events`;
  return { http, ws };
}

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
  /** Current daemon lifecycle phase. Initialized to a sentinel so callers
   *  (settings tab / E2E) can distinguish "onload hasn't finished" from a
   *  real terminal state. */
  daemonStatus: DaemonStatus = {
    state: "spawn-failed",
    error: "not-initialized",
  };

  async onload() {
    this.settings = await makeSettingsStore({
      loadData: () => this.loadData(),
      saveData: (d) => this.saveData(d),
    });
    // Register the settings tab BEFORE any failure return — degraded states
    // need a path for the user to set voidOsBinaryPath manually.
    this.addSettingTab(new VoidOsSettingsTab(this.app, this));

    let attachment: DaemonAttachment;
    try {
      const vaultRoot = getVaultRoot(this.app);
      attachment = await ensureDaemon({
        vaultRoot,
        settings: this.settings.get(),
        probeHealth: makeProductionProbe(homedir()),
        spawnCli: makeProductionSpawn(),
      });
    } catch (e) {
      if (e instanceof BinaryNotFoundError) {
        new Notice("void-os binary not found — set the path in plugin settings");
        this.daemonStatus = { state: "binary-missing" };
      } else if (e instanceof VaultMismatchError) {
        new Notice(
          `daemon already running for ${e.activeVault}; close that vault first`,
        );
        this.daemonStatus = {
          state: "vault-mismatch",
          activeVault: e.activeVault,
        };
      } else if (e instanceof SpawnError) {
        new Notice(`failed to start daemon: ${e.message}`);
        this.daemonStatus = { state: "spawn-failed", error: e.message };
      } else if (e instanceof UnsupportedPlatformError) {
        new Notice("void-os requires Obsidian desktop");
        this.daemonStatus = { state: "spawn-failed", error: e.message };
      } else {
        throw e;
      }
      // Degraded: chat UI / WS / commands are NOT registered.
      return;
    }

    this.daemonStatus = {
      state: "running",
      port: attachment.port,
      vault: attachment.vault_root,
      version: attachment.version,
    };

    // Cache a successful binary resolution so future loads skip the bash
    // `command -v` probe. Best-effort — failure here is non-fatal.
    if (!this.settings.get().resolvedBinaryPath) {
      try {
        const resolved = await resolveBinary(this.settings.get());
        await this.settings.setResolvedBinaryPath(resolved);
      } catch {
        // ensureDaemon already succeeded; cache miss is silent.
      }
    }

    const urls = urlsFromAttachment(attachment);
    this.bus = new FrameBus();
    const api = makeChatApi(urls.http, requestUrlAsFetch());
    const agentsApi = makeAgentsApi(urls.http, requestUrlAsFetch());
    const pickerFactory = makeRealAgentPickerFactory(this.app);

    const openPicker = (): Promise<AgentListEntry | null> =>
      openAgentPicker({
        agentsApi,
        modalFactory: pickerFactory,
        onError: defaultOnError,
      });

    // Single WebSocket — FSM owns reconnect, FrameBus piggybacks on frames.
    const wsClient = new WsClient(urls.ws);
    const tapped = tapFrames(wsClient, this.bus);

    this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
      new ChatView(leaf, () => ({
        bus: this.bus!,
        api,
        agentsApi,
        chatId: this.settings!.get().chatId,
        onChatIdMinted: (id) => this.settings!.setChatId(id),
        defaultAgent: "maya", // retained as fallback only
        openPicker,
      })),
    );

    const statusBarEl = this.addStatusBarItem();
    statusBarEl.setAttribute("data-testid", "vos-status-bar");
    const statusBar = new StatusBar(statusBarEl);
    this.fsm = new ReconnectFSM({
      client: tapped,
      onState: (s) => statusBar.update(s),
      retryMs: DEFAULT_RETRY_MS,
      pingMs: DEFAULT_PING_MS,
      pongTimeoutMs: DEFAULT_PONG_TIMEOUT_MS,
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
        // Mint FIRST so settings.chatId is correct for any fresh leaf the
        // view opens against; then activate with the id so an already-open
        // leaf gets the id pushed into ChatRoot's state.
        const created = await api.createChat(picked.name);
        await this.settings!.setChatId(created.id);
        await this.activateChatView(created.id);
      },
    });
  }

  async onunload() {
    this.fsm?.stop();
    this.fsm = null;
    this.bus = null;
  }

  private async activateChatView(chatId?: string) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    // When called with a chatId (command path), push it into ChatRoot via
    // the view's imperative setter. Required because the deps factory only
    // runs once at mount — a chat minted while the view is already open
    // won't otherwise activate until next plugin reload.
    if (chatId) {
      const view = leaf.view;
      if (view instanceof ChatView) view.setActiveChatId(chatId);
    }
  }
}
