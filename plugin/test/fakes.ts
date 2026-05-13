import { ReconnectFSM } from "../src/reconnect";
import type { ConnectionState } from "../src/state";
import type { WsEvent, WsPort } from "../src/ws-client";

export class FakeClock {
  private now = 0;
  private timers: { at: number; fn: () => void; id: number; interval?: number }[] = [];
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): any {
    const id = this.nextId++;
    this.timers.push({ at: this.now + ms, fn, id });
    return id;
  }
  clearTimeout(id: any): any { this.timers = this.timers.filter((t) => t.id !== id); }
  setInterval(fn: () => void, ms: number): any {
    const id = this.nextId++;
    this.timers.push({ at: this.now + ms, fn, id, interval: ms });
    return id;
  }
  clearInterval(id: any): any { this.timers = this.timers.filter((t) => t.id !== id); }

  advance(ms: number) {
    const target = this.now + ms;
    while (true) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const t = due[0];
      this.now = t.at;
      if (t.interval !== undefined) {
        t.at = this.now + t.interval;
        t.fn();
      } else {
        this.timers = this.timers.filter((x) => x.id !== t.id);
        t.fn();
      }
    }
    this.now = target;
  }
}

export class FakeWs implements WsPort {
  opened = 0;
  closed = 0;
  sent: unknown[] = [];
  handler: ((e: WsEvent) => void) | null = null;
  open() { this.opened++; }
  close() { this.closed++; }
  send(frame: unknown) { this.sent.push(frame); }
  on(h: (e: WsEvent) => void) { this.handler = h; }
  emit(e: WsEvent) { this.handler!(e); }
}

export const makeFsm = () => {
  const clock = new FakeClock();
  const ws = new FakeWs();
  const states: ConnectionState[] = [];
  const fsm = new ReconnectFSM({
    client: ws,
    onState: (s) => states.push(s),
    retryMs: 2000,
    pingMs: 10000,
    pongTimeoutMs: 25000,
    setTimeout: clock.setTimeout.bind(clock) as any,
    clearTimeout: clock.clearTimeout.bind(clock) as any,
    setInterval: clock.setInterval.bind(clock) as any,
    clearInterval: clock.clearInterval.bind(clock) as any,
  });
  return { fsm, ws, clock, states };
};
