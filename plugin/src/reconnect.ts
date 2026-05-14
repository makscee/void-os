import type { ConnectionState } from "./state";
import type { WsPort, WsEvent } from "./ws-client";

interface Deps {
  client: WsPort;
  onState: (s: ConnectionState) => void;
  retryMs: number;
  pingMs: number;
  pongTimeoutMs: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

type Phase = "offline" | "connecting" | "connected" | "reconnecting";

export class ReconnectFSM {
  private phase: Phase = "offline";
  private retryHandle: any = null;
  private pingHandle: any = null;
  private pongHandle: any = null;
  private setT: typeof setTimeout;
  private clrT: typeof clearTimeout;
  private setI: typeof setInterval;
  private clrI: typeof clearInterval;

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
        return;
      case "frame":
        if ((e.data as any)?.type === "pong") this.clearPong();
        return;
      case "close":
      case "error":
        this.scheduleRetry();
        return;
    }
  }

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
  }

  private transition(p: Phase) {
    if (this.phase === p) return;
    this.phase = p;
    const visible: ConnectionState =
      p === "connected" ? "connected"
      : p === "offline" ? "offline"
      : "reconnecting";
    this.d.onState(visible);
  }
}
