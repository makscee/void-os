import type { ConnectionState } from "./state";
import type { WsPort, WsEvent } from "./ws-client";

interface Deps {
  client: WsPort;
  onState: (s: ConnectionState) => void;
  retryMs: number;
  pingMs: number;
  pongTimeoutMs: number;
  /** Probe /health to distinguish "WS dropped" from "daemon process died".
   *  Optional: when absent, FSM behaves as pre-VOS-120 (retry forever). */
  probeHealth?: () => Promise<{ ok: boolean; port: number; vault_root: string; version: string }>;
  /** Spawn a fresh daemon when probeHealth confirms the process is gone.
   *  Optional: when absent, FSM skips the auto-respawn step. */
  respawn?: () => Promise<void>;
  /** How long the WS must stay in "connected" before the auto-respawn budget
   *  resets (so a future crash also gets one free recovery). Defaults 5min. */
  stableResetMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/** Internal phase. "daemon-died" is transient (we're respawning); "manual-restart"
 *  is sticky until resetAutoRespawn() is called (e.g. Settings → Restart). */
type Phase =
  | "offline"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "daemon-died"
  | "manual-restart";

export class ReconnectFSM {
  private phase: Phase = "offline";
  private retryHandle: any = null;
  private pingHandle: any = null;
  private pongHandle: any = null;
  private stableHandle: any = null;
  private autoRespawnUsed = false;
  private setT: typeof setTimeout;
  private clrT: typeof clearTimeout;
  private setI: typeof setInterval;
  private clrI: typeof clearInterval;

  /** Test/inspection accessor — returns current internal phase. */
  get state(): Phase { return this.phase; }

  constructor(private d: Deps) {
    // Native browser timers (setTimeout/clearTimeout/setInterval/clearInterval)
    // must be invoked with `this === globalThis` in Electron's renderer; storing
    // them as instance properties and calling `this.setI(...)` rebinds `this`
    // to the FSM and throws "Illegal invocation". Bind native fallbacks to
    // globalThis at capture time. Injected (test) timers are pre-bound by the
    // caller and used as-is.
    const g: any = globalThis;
    this.setT = d.setTimeout ?? setTimeout.bind(g);
    this.clrT = d.clearTimeout ?? clearTimeout.bind(g);
    this.setI = d.setInterval ?? setInterval.bind(g);
    this.clrI = d.clearInterval ?? clearInterval.bind(g);
    d.client.on((e) => this.onEvent(e));
  }

  start() {
    if (this.phase !== "offline" && this.phase !== "reconnecting") return;
    this.transition("connecting");
    this.d.client.open();
  }

  stop() {
    this.clearTimers();
    this.d.client.close();
    this.transition("offline");
  }

  private onEvent(e: WsEvent) {
    switch (e.kind) {
      case "open":
        return;
      case "hello":
        this.transition("connected");
        this.startPing();
        this.armStableReset();
        return;
      case "frame":
        if ((e.data as any)?.type === "pong") this.clearPong();
        return;
      case "close":
      case "error":
        // VOS-120 T7: when the daemon process is gone (not just WS dropped),
        // attempt ONE auto-respawn before falling back to the normal retry loop.
        void this.handleDisconnect();
        return;
    }
  }

  /** WS close/error path. Probes /health; on probe-fail we treat the daemon
   *  as dead and spend the auto-respawn budget. On success (or no probe
   *  configured) we fall through to the existing retry-loop behaviour. */
  private async handleDisconnect(): Promise<void> {
    if (this.phase === "offline" || this.phase === "reconnecting" ||
        this.phase === "daemon-died" || this.phase === "manual-restart") {
      return;
    }
    if (!this.d.probeHealth) {
      this.scheduleRetry();
      return;
    }
    let daemonAlive = false;
    try {
      const h = await this.d.probeHealth();
      daemonAlive = !!h?.ok;
    } catch {
      daemonAlive = false;
    }
    if (daemonAlive) {
      this.scheduleRetry();
      return;
    }
    if (this.autoRespawnUsed || !this.d.respawn) {
      this.clearTimers();
      this.d.client.close();
      this.transition("manual-restart");
      return;
    }
    this.autoRespawnUsed = true;
    this.clearTimers();
    this.d.client.close();
    this.transition("daemon-died");
    try {
      await this.d.respawn();
      this.transition("connecting");
      this.d.client.open();
    } catch {
      this.transition("manual-restart");
    }
  }

  /** Arm a one-shot timer that clears the auto-respawn budget once the WS
   *  has been continuously connected for stableResetMs. Re-armed on every
   *  fresh hello — any disconnect cancels it via clearTimers(). */
  private armStableReset() {
    if (this.stableHandle) { this.clrT(this.stableHandle); this.stableHandle = null; }
    const ms = this.d.stableResetMs ?? 5 * 60_000;
    this.stableHandle = this.setT(() => {
      if (this.phase === "connected") this.autoRespawnUsed = false;
      this.stableHandle = null;
    }, ms);
  }

  /** Exposed for T8 Settings → Restart wiring: clears the spent budget so a
   *  user-triggered restart effectively starts a fresh recovery cycle. */
  resetAutoRespawn(): void { this.autoRespawnUsed = false; }

  private startPing() {
    this.pingHandle = this.setI(() => {
      this.d.client.send({ type: "ping" });
      // Arm the pong timer ONLY when no pong is outstanding.
      if (!this.pongHandle) {
        this.pongHandle = this.setT(() => this.scheduleRetry(), this.d.pongTimeoutMs);
      }
    }, this.d.pingMs);
  }

  private clearPong() {
    if (this.pongHandle) { this.clrT(this.pongHandle); this.pongHandle = null; }
  }

  private scheduleRetry() {
    if (this.phase === "offline" || this.phase === "reconnecting") return;
    this.clearTimers();
    this.d.client.close();
    this.transition("reconnecting");
    this.retryHandle = this.setT(() => this.start(), this.d.retryMs);
  }

  private clearTimers() {
    if (this.pingHandle) { this.clrI(this.pingHandle); this.pingHandle = null; }
    this.clearPong();
    if (this.retryHandle) { this.clrT(this.retryHandle); this.retryHandle = null; }
    if (this.stableHandle) { this.clrT(this.stableHandle); this.stableHandle = null; }
  }

  private transition(p: Phase) {
    if (this.phase === p) return;
    this.phase = p;
    const visible: ConnectionState =
      p === "connected" ? "connected"
      : p === "offline" || p === "manual-restart" ? "offline"
      : "reconnecting";
    this.d.onState(visible);
  }
}
