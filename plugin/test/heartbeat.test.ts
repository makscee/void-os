import { describe, test, expect } from "bun:test";
import { makeFsm } from "./fakes";

describe("Heartbeat", () => {
  test("first ping fires 10s after hello", () => {
    const { fsm, ws, clock } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    clock.advance(9999);
    expect(ws.sent.length).toBe(0);
    clock.advance(1);
    expect(ws.sent).toEqual([{ type: "ping" }]);
  });

  test("ping fires every 10s while connected", () => {
    const { fsm, ws, clock } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    clock.advance(30000);
    expect(ws.sent.length).toBe(3);
  });

  test("pong frame clears the pong timer", () => {
    const { fsm, ws, clock, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    clock.advance(10000); // ping #1 sent, pong armed
    ws.emit({ kind: "frame", data: { type: "pong" } });
    clock.advance(25000); // would have fired pong-timeout if not cleared
    // No reconnecting transition triggered by pong timeout:
    expect(states.filter((s) => s === "reconnecting").length).toBe(1); // only the initial "connecting"
  });

  test("missing pong at 25s triggers reconnect", () => {
    const { fsm, ws, clock, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    clock.advance(10000); // ping #1 sent, pong armed at t=10s
    clock.advance(24999);
    expect(states[states.length - 1]).toBe("connected");
    clock.advance(1); // t=35s, pong-timeout fires
    expect(states[states.length - 1]).toBe("reconnecting");
  });

  test("subsequent pings do NOT re-arm pong (half-dead daemon regression)", () => {
    // Daemon goes silent right after hello. Plugin pings at 10s, 20s, 30s,...
    // Pong timer must measure from the FIRST unanswered ping (armed at 10s)
    // and fire at 35s total — NOT get reset by ping #2 at 20s into another 25s.
    const { fsm, ws, clock, states } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    clock.advance(10000); // ping #1, pong armed for t=35s
    clock.advance(10000); // ping #2 at t=20s, must NOT re-arm
    clock.advance(10000); // ping #3 at t=30s, must NOT re-arm
    expect(states[states.length - 1]).toBe("connected");
    clock.advance(5000); // t=35s → pong-timeout fires
    expect(states[states.length - 1]).toBe("reconnecting");
  });
});
