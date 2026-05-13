export type WsEvent =
  | { kind: "open" }
  | { kind: "hello"; version: string }
  | { kind: "frame"; data: unknown }
  | { kind: "close" }
  | { kind: "error"; reason: string };

export interface WsPort {
  open(): void;
  send(frame: unknown): void;
  close(): void;
  on(handler: (e: WsEvent) => void): void;
}

export class WsClient implements WsPort {
  private ws: WebSocket | null = null;
  private handler: ((e: WsEvent) => void) | null = null;
  constructor(private url: string) {}

  on(h: (e: WsEvent) => void) { this.handler = h; }

  open() {
    if (this.ws) return;
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.handler?.({ kind: "open" });
    this.ws.onmessage = (ev: MessageEvent) => {
      let parsed: any;
      try { parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); }
      catch { return this.handler?.({ kind: "error", reason: "bad-json" }); }
      if (parsed?.type === "hello" && typeof parsed.version === "string") {
        this.handler?.({ kind: "hello", version: parsed.version });
      } else {
        this.handler?.({ kind: "frame", data: parsed });
      }
    };
    this.ws.onerror = () => this.handler?.({ kind: "error", reason: "ws-error" });
    this.ws.onclose = () => { this.ws = null; this.handler?.({ kind: "close" }); };
  }

  send(frame: unknown) { this.ws?.send(JSON.stringify(frame)); }
  close() { const w = this.ws; this.ws = null; w?.close(); }
}
