import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WsClient, type WsEvent } from "../src/ws-client";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static lastUrl = "";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(url: string) { FakeWebSocket.lastUrl = url; FakeWebSocket.instances.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; this.onclose?.(); }
}

const collect = (client: WsClient): WsEvent[] => {
  const evts: WsEvent[] = [];
  client.on((e) => evts.push(e));
  return evts;
};

let realWS: any;
beforeEach(() => {
  realWS = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
});
afterEach(() => {
  (globalThis as any).WebSocket = realWS;
});

describe("WsClient", () => {
  test("open() instantiates WebSocket with given url", () => {
    const c = new WsClient("ws://test/events");
    c.open();
    expect(FakeWebSocket.lastUrl).toBe("ws://test/events");
  });

  test("emits open event when underlying socket opens", () => {
    const c = new WsClient("ws://x");
    const evts = collect(c);
    c.open();
    FakeWebSocket.instances[0].onopen!();
    expect(evts).toEqual([{ kind: "open" }]);
  });

  test("emits hello event when daemon sends hello frame", () => {
    const c = new WsClient("ws://x");
    const evts = collect(c);
    c.open();
    FakeWebSocket.instances[0].onmessage!({ data: JSON.stringify({ type: "hello", version: "0.1.0" }) });
    expect(evts).toEqual([{ kind: "hello", version: "0.1.0" }]);
  });

  test("emits frame event for other JSON messages", () => {
    const c = new WsClient("ws://x");
    const evts = collect(c);
    c.open();
    FakeWebSocket.instances[0].onmessage!({ data: JSON.stringify({ type: "pong" }) });
    expect(evts).toEqual([{ kind: "frame", data: { type: "pong" } }]);
  });

  test("emits error event for invalid JSON", () => {
    const c = new WsClient("ws://x");
    const evts = collect(c);
    c.open();
    FakeWebSocket.instances[0].onmessage!({ data: "not json" });
    expect(evts).toEqual([{ kind: "error", reason: "bad-json" }]);
  });

  test("emits error event when ws errors", () => {
    const c = new WsClient("ws://x");
    const evts = collect(c);
    c.open();
    FakeWebSocket.instances[0].onerror!();
    expect(evts).toEqual([{ kind: "error", reason: "ws-error" }]);
  });

  test("emits close event when ws closes", () => {
    const c = new WsClient("ws://x");
    const evts = collect(c);
    c.open();
    FakeWebSocket.instances[0].onclose!();
    expect(evts).toEqual([{ kind: "close" }]);
  });

  test("send() forwards JSON-stringified frame to ws", () => {
    const c = new WsClient("ws://x");
    c.open();
    c.send({ type: "ping" });
    expect(FakeWebSocket.instances[0].sent).toEqual([JSON.stringify({ type: "ping" })]);
  });

  test("open() is idempotent — second call does not create new socket", () => {
    const c = new WsClient("ws://x");
    c.open();
    c.open();
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  test("close() closes ws and allows reopen", () => {
    const c = new WsClient("ws://x");
    c.open();
    c.close();
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    c.open();
    expect(FakeWebSocket.instances.length).toBe(2);
  });
});
