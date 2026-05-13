import { describe, test, expect } from "bun:test";
import { makeFsm } from "./fakes";

describe("ReconnectFSM", () => {
  test("start() opens socket and emits reconnecting state", () => {
    const { fsm, ws, states } = makeFsm();
    fsm.start();
    expect(ws.opened).toBe(1);
    expect(states).toEqual(["reconnecting"]); // "connecting" surfaces as "reconnecting"
  });

  test("hello frame flips to connected", () => {
    const { fsm, ws, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "open" });
    ws.emit({ kind: "hello", version: "0.1.0" });
    expect(states).toEqual(["reconnecting", "connected"]);
  });

  test("open() alone (no hello) does NOT flip to connected", () => {
    const { fsm, ws, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "open" });
    expect(states).toEqual(["reconnecting"]);
  });

  test("close while connected schedules retry and re-opens after 2s", () => {
    const { fsm, ws, clock, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    expect(states[states.length - 1]).toBe("reconnecting");
    expect(ws.opened).toBe(1);
    clock.advance(2000);
    expect(ws.opened).toBe(2);
  });

  test("error while connected schedules retry", () => {
    const { fsm, ws, clock, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "error", reason: "ws-error" });
    expect(states[states.length - 1]).toBe("reconnecting");
    clock.advance(2000);
    expect(ws.opened).toBe(2);
  });

  test("stop() closes socket and goes offline; no further retries", () => {
    const { fsm, ws, clock, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    fsm.stop();
    expect(states[states.length - 1]).toBe("offline");
    clock.advance(60000);
    expect(ws.opened).toBe(1); // no reopen after stop
  });

  test("duplicate close events do not stack retries", () => {
    const { fsm, ws, clock } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    ws.emit({ kind: "close" });
    clock.advance(2000);
    expect(ws.opened).toBe(2);
  });

  test("re-emits onState only on actual transitions", () => {
    const { fsm, ws, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "hello", version: "0.1.0" }); // duplicate, no extra "connected"
    const connectedCount = states.filter((s) => s === "connected").length;
    expect(connectedCount).toBe(1);
  });
});
