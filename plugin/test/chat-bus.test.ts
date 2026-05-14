import { describe, test, expect } from "bun:test";
import { FrameBus } from "../src/chat/bus";

describe("FrameBus", () => {
  test("fans out emitted frames to all subscribers", () => {
    const bus = new FrameBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.on((f) => a.push(f));
    bus.on((f) => b.push(f));
    bus.emit({ type: "chat.token", chat_id: "c", run_id: "r", delta: "x" });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new FrameBus();
    const seen: unknown[] = [];
    const off = bus.on((f) => seen.push(f));
    bus.emit({ type: "x" });
    off();
    bus.emit({ type: "y" });
    expect(seen.length).toBe(1);
  });

  test("a throwing handler does not block others", () => {
    const bus = new FrameBus();
    const seen: unknown[] = [];
    bus.on(() => { throw new Error("boom"); });
    bus.on((f) => seen.push(f));
    bus.emit({ type: "ping" });
    expect(seen.length).toBe(1);
  });
});
