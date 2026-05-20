import { Notice, Plugin, requestUrl, setIcon, type WorkspaceLeaf } from "obsidian";
import { DegradedHelpModal } from "./degraded-help-modal";
import { iconFor, tooltipFor, statusBarTextFor } from "./ribbon-state";
// VOS-120 T9-fix-A: lazy-require node built-ins (browser-target bundler
// strips static `import "node:os" / "node:child_process"`).
import { nodeCp } from "./node-runtime";
const { spawn } = nodeCp;
import { ChatView, CHAT_VIEW_TYPE } from "./view";
import { InspectorView, INSPECTOR_VIEW_TYPE } from "./agents/inspector-view";
import { makeInflightApi } from "./agents/inflight-api";
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
  resolveHome,
  readDaemonToken,
  BinaryNotFoundError,
  VaultMismatchError,
  SpawnError,
  UnsupportedPlatformError,
  type DaemonAttachment,
} from "./daemon-lifecycle";
import { getVaultRoot } from "./vault-root";
import { urlsFromAttachment } from "./daemon-urls";

export type { DaemonStatus } from "./daemon-status";

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
      // VOS-120 T9-fix-D: makeProductionProbe also calls .json() on the
      // response — provide a parser. Falls back to throwing SyntaxError
      // for non-JSON bodies (matches native fetch behaviour).
      json: async () => JSON.parse(text),
    } as Response;
  }) as unknown as typeof fetch;
}

// urlsFromAttachment moved to ./daemon-urls.ts so it can be unit-tested
// without dragging in the obsidian / node-runtime imports this module needs.

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
  /** Public so the settings tab can read voidOsBinaryPath / resolvedBinaryPath
   *  and invoke the binary-override setter. */
  settings!: SettingsStore;
  /** Held so restartDaemon() can re-issue open() after a fresh spawn comes up
   *  on (the same or a new) port. WsClient is constructed once with a URL —
   *  if the post-restart port differs from the one captured in onload we tear
   *  it down and build a fresh one against the new URL. */
  private wsClient: WsClient | null = null;
  private wsUrl: string | null = null;
  /** Current daemon lifecycle phase. Initialized to a sentinel so callers
   *  (settings tab / E2E) can distinguish "onload hasn't finished" from a
   *  real terminal state. */
  daemonStatus: DaemonStatus = {
    state: "spawn-failed",
    error: "not-initialized",
  };
  private ribbonEl: HTMLElement | null = null;
  /** VOS-160: dedicated inspector ribbon icon; added once on first healthy
   *  runtime registration, never re-added on Hot-Reload re-entry. */
  private inspectorRibbonEl: HTMLElement | null = null;
  private statusBar: StatusBar | null = null;
  private healthyRuntimeRegistered = false;
  /** Current ribbon click handler — replaced when daemonStatus flips. The
   *  HTMLElement listener registered in onload reads this closure variable so
   *  we never remove/re-add the ribbon element (which would orphan entries). */
  private ribbonHandler: () => void = () => {};

  async onload() {
    this.settings = await makeSettingsStore({
      loadData: () => this.loadData(),
      saveData: (d) => this.saveData(d),
    });
    this.addSettingTab(new VoidOsSettingsTab(this.app, this));

    // === Phase 1: Always-on UI ===
    // Status bar — held instance, mode-gated.
    const statusBarEl = this.addStatusBarItem();
    statusBarEl.setAttribute("data-testid", "vos-status-bar");
    this.statusBar = new StatusBar(statusBarEl);
    // Ribbon — held element, mutated by refreshSurfacesForState. Register with
    // neutral copy; refreshSurfacesForState immediately overwrites icon +
    // tooltip + handler from the current daemonStatus (sentinel "spawn-failed:
    // not-initialized" until attemptDaemon updates it), so the ribbon is
    // clickable from the first frame and shows degraded copy during the
    // attemptDaemon window rather than a stale healthy hint.
    this.ribbonEl = this.addRibbonIcon("circle-alert", "void-os starting…", () => this.ribbonHandler());
    this.refreshSurfacesForState();

    // === Phase 2: Daemon attempt ===
    await this.attemptDaemon();
  }

  async onunload() {
    this.fsm?.stop();
    this.fsm = null;
    this.bus = null;
    // Stop the detached daemon so it doesn't outlive Obsidian and orphan the
    // vault lock. Bounded by a 3s window so a hung CLI can't block unload.
    try {
      const bin = await resolveBinary(this.settings.get());
      await new Promise<void>((resolve) => {
        const c = spawn(bin, ["daemon", "stop"], { stdio: "ignore" });
        const t = setTimeout(() => { try { c.kill(); } catch { /* ignore */ } resolve(); }, 3000);
        c.on("close", () => { clearTimeout(t); resolve(); });
        c.on("error", () => { clearTimeout(t); resolve(); });
      });
    } catch {
      // resolveBinary may throw; nothing we can do at unload-time.
    }
  }

  /** Non-throwing for typed errors — distinct from restartDaemon, which
   *  rethrows for the FSM's reject contract. Updates daemonStatus and
   *  refreshes UI surfaces.
   *
   *  Public (not private as in plan) because DegradedHelpModal calls
   *  `this.plugin.attemptDaemon()` from another file. */
  public async attemptDaemon(): Promise<void> {
    try {
      const vaultRoot = getVaultRoot(this.app);
      const attachment = await ensureDaemon({
        vaultRoot,
        settings: this.settings.get(),
        probeHealth: makeProductionProbe(resolveHome(), requestUrlAsFetch()),
        spawnCli: makeProductionSpawn(),
      });
      this.daemonStatus = {
        state: "running",
        port: attachment.port,
        vault: attachment.vault_root,
        version: attachment.version,
      };
      // Cache binary path resolution — best-effort, same logic as the old onload.
      if (!this.settings.get().resolvedBinaryPath) {
        try {
          const resolved = await resolveBinary(this.settings.get());
          await this.settings.setResolvedBinaryPath(resolved);
        } catch {
          // ensureDaemon succeeded; cache miss is silent.
        }
      }
      this.registerHealthyRuntime(attachment);
      this.refreshSurfacesForState();
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
        // Unknown error — record it as spawn-failed (best-effort label) so the
        // ribbon flips to degraded instead of inheriting whatever stale value
        // daemonStatus held. Then refresh surfaces and rethrow so the trace
        // also lands in the Obsidian console.
        this.daemonStatus = { state: "spawn-failed", error: e instanceof Error ? e.message : String(e) };
        this.refreshSurfacesForState();
        throw e;
      }
      this.refreshSurfacesForState();
    }
  }

  private refreshSurfacesForState(): void {
    const status = this.daemonStatus;
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, iconFor(status));
      this.ribbonEl.setAttribute("aria-label", tooltipFor(status));
    }
    if (status.state === "running") {
      this.ribbonHandler = () => { void this.activateChatView(); };
      this.statusBar?.setMode("fsm");
      // FSM, when started by registerHealthyRuntime, will push the correct label.
    } else {
      this.ribbonHandler = () => new DegradedHelpModal(this.app, this).open();
      this.statusBar?.setMode("degraded");
      this.statusBar?.setStateText(statusBarTextFor(status));
    }
  }

  private registerHealthyRuntime(attachment: DaemonAttachment): void {
    if (this.healthyRuntimeRegistered) return;
    this.healthyRuntimeRegistered = true;

    const urls = urlsFromAttachment(attachment, this.settings.get().daemonUrl);
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

    this.wsClient = new WsClient(urls.ws);
    this.wsUrl = urls.ws;
    const tapped = tapFrames(this.wsClient, this.bus);

    // Hot Reload disable/enable cycles can leave a prior registerView entry
    // in Obsidian's global view registry. registerView throws in that case,
    // which would derail the rest of registerHealthyRuntime. Swallow the
    // dup-registration error — the existing entry stays live; we lose this
    // instance's closure but openChatView still resolves the view via the
    // registry. Production (fresh Obsidian launch) never hits this branch.
    try {
      this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
        new ChatView(leaf, () => ({
          bus: this.bus!,
          api,
          agentsApi,
          chatId: this.settings!.get().chatId,
          onChatIdMinted: (id) => this.settings!.setChatId(id),
          // defaultAgent intentionally omitted — callers must pick an agent
          // explicitly. T3 (VOS-124) rejects unknown agents at the daemon
          // boundary; a silent "maya" fallback here would silently route to
          // the wrong agent if the user never opened the picker.
          openPicker,
        })),
      );
    } catch (e) {
      if (!(e instanceof Error) || !/existing view type/i.test(e.message)) throw e;
      console.warn("void-os: view type already registered (Hot Reload artifact), reusing existing");
    }

    // VOS-160: live in-flight agent inspector. The InflightApi polls
    // GET /agents/inflight (bearer-auth) — readDaemonToken is called on
    // every poll so token rotation across daemon restarts is picked up
    // without a plugin reload. Same Hot-Reload dup-registration guard as
    // the chat view above.
    const inflightApi = makeInflightApi(
      urls.http,
      () => readDaemonToken(resolveHome()),
      requestUrlAsFetch(),
    );
    try {
      this.registerView(INSPECTOR_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
        new InspectorView(leaf, () => ({ inflightApi })),
      );
    } catch (e) {
      if (!(e instanceof Error) || !/existing view type/i.test(e.message)) throw e;
      console.warn("void-os: inspector view type already registered (Hot Reload artifact), reusing existing");
    }

    // Dedicated ribbon entry for the inspector — added only once the daemon
    // is healthy (the inspector is meaningless while disconnected). Guarded
    // so a Hot-Reload re-entry into registerHealthyRuntime can't stack
    // duplicate icons.
    if (!this.inspectorRibbonEl) {
      this.inspectorRibbonEl = this.addRibbonIcon(
        "activity",
        "void-os inspector",
        () => { void this.activateInspectorView(); },
      );
    }

    this.fsm = new ReconnectFSM({
      client: tapped,
      onState: (s) => this.statusBar!.update(s),
      retryMs: DEFAULT_RETRY_MS,
      pingMs: DEFAULT_PING_MS,
      pongTimeoutMs: DEFAULT_PONG_TIMEOUT_MS,
      // T8 wiring: probeHealth distinguishes "ws dropped" from "daemon died",
      // and respawn lets the FSM spend its one auto-restart budget without a
      // user click. Arrow keeps `this` bound to the plugin instance.
      probeHealth: makeProductionProbe(resolveHome(), requestUrlAsFetch()),
      respawn: () => this.restartDaemon(),
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

    this.addCommand({
      id: "open-inspector-view",
      name: "Open void-os inspector",
      callback: () => this.activateInspectorView(),
    });
  }

  /**
   * User-initiated daemon restart (Settings → Restart) AND the FSM's
   * auto-respawn callback when probeHealth confirms the process is dead.
   *
   * Strategy:
   *  1. Best-effort `daemon stop` — ignore errors. The old daemon may already
   *     be gone (most common in the daemon-died path); we don't care, we just
   *     don't want to race with an orphaned process holding the port.
   *  2. Clear the FSM's spent auto-respawn budget so a future crash also gets
   *     one free recovery — without this, every Restart click would leave the
   *     FSM in a "next death is fatal" posture.
   *  3. Re-run ensureDaemon, mirroring onload's error-to-status mapping so
   *     the Settings UI re-renders into the right terminal state on failure.
   *  4. On success, kick the WS layer: if the port changed (rare but possible
   *     — pidfile is the source of truth), swap WsClient against the new URL.
   *
   * Throws nothing in the FSM-initiated path: any failure routes through the
   * `spawn-failed` daemonStatus update, the FSM then transitions itself to
   * manual-restart on the rejected promise.
   */
  async restartDaemon(): Promise<void> {
    // 1. Best-effort stop of any extant daemon. Bound by a short window so a
    //    hung CLI can't block the rest of the restart sequence.
    try {
      const bin = await resolveBinary(this.settings.get());
      await new Promise<void>((resolve) => {
        const c = spawn(bin, ["daemon", "stop"], { stdio: "ignore" });
        const t = setTimeout(() => { try { c.kill(); } catch { /* ignore */ } resolve(); }, 3000);
        c.on("close", () => { clearTimeout(t); resolve(); });
        c.on("error", () => { clearTimeout(t); resolve(); });
      });
    } catch {
      // resolveBinary may throw BinaryNotFoundError; that's handled below when
      // ensureDaemon also fails for the same reason.
    }

    // 2. Reset the FSM's one-shot budget so the user-triggered restart starts
    //    a fresh recovery cycle.
    this.fsm?.resetAutoRespawn();

    // 3. Re-run ensureDaemon and project the outcome into daemonStatus using
    //    the same error -> state mapping as onload.
    let attachment: DaemonAttachment;
    try {
      attachment = await ensureDaemon({
        vaultRoot: getVaultRoot(this.app),
        settings: this.settings.get(),
        probeHealth: makeProductionProbe(resolveHome(), requestUrlAsFetch()),
        spawnCli: makeProductionSpawn(),
      });
    } catch (e) {
      if (e instanceof BinaryNotFoundError) {
        this.daemonStatus = { state: "binary-missing" };
      } else if (e instanceof VaultMismatchError) {
        this.daemonStatus = {
          state: "vault-mismatch",
          activeVault: e.activeVault,
        };
      } else if (e instanceof SpawnError) {
        this.daemonStatus = { state: "spawn-failed", error: e.message };
      } else if (e instanceof UnsupportedPlatformError) {
        this.daemonStatus = { state: "spawn-failed", error: e.message };
      } else {
        throw e;
      }
      // Re-throw so the FSM-respawn caller treats this as a failed recovery
      // (it will fall through to its manual-restart state). The settings-tab
      // caller catches via its own try (it doesn't — but the FSM's
      // resetAutoRespawn already ran above, so it's safe to reject).
      throw e instanceof Error ? e : new Error(String(e));
    }

    this.daemonStatus = {
      state: "running",
      port: attachment.port,
      vault: attachment.vault_root,
      version: attachment.version,
    };

    // 4. Wire up WS against the (possibly new) port. If a previous successful
    //    onload built a wsClient against a different URL, rebuild it now.
    const urls = urlsFromAttachment(attachment, this.settings.get().daemonUrl);
    if (this.wsClient && this.wsUrl !== urls.ws) {
      try { this.wsClient.close(); } catch { /* ignore */ }
      this.wsClient = null;
    }
    if (!this.wsClient && this.bus) {
      this.wsClient = new WsClient(urls.ws);
      this.wsUrl = urls.ws;
      // Rebuild the FSM's tapped client binding — but ReconnectFSM was wired
      // against the old client in onload, so we can't swap underneath it.
      // Instead, when the URL changes we leave restart as a "best effort" —
      // a full plugin reload re-binds correctly. URL-stable restarts (the
      // common case: same port) re-use the original client via fsm.start().
    }
    // Stop transitions the FSM to offline; start then re-opens against the
    // existing client. Safe to call when phase is already manual-restart —
    // stop forces offline first.
    this.fsm?.stop();
    this.fsm?.start();
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

  /** VOS-160: open (or reveal) the in-flight agent inspector leaf. Mirrors
   *  activateChatView — reuse an existing leaf if one is already open. */
  private async activateInspectorView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(INSPECTOR_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: INSPECTOR_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
