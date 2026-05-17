import { describe, test, expect } from "bun:test";
import { makeFsm } from "./fakes";
import { ReconnectFSM } from "../src/reconnect";
import { FakeClock, FakeWs } from "./fakes";
import type { ConnectionState } from "../src/state";

type ProbeResult = { ok: boolean; port: number; vault_root: string; version: string };

const makeDaemonFsm = (opts: {
  probe: () => Promise<ProbeResult>;
  respawn?: () => Promise<void>;
  stableResetMs?: number;
}) => {
  const clock = new FakeClock();
  const ws = new FakeWs();
  const states: ConnectionState[] = [];
  const fsm = new ReconnectFSM({
    client: ws,
    onState: (s) => states.push(s),
    retryMs: 2000,
    pingMs: 10000,
    pongTimeoutMs: 25000,
    probeHealth: opts.probe,
    respawn: opts.respawn,
    stableResetMs: opts.stableResetMs,
    setTimeout: clock.setTimeout.bind(clock) as any,
    clearTimeout: clock.clearTimeout.bind(clock) as any,
    setInterval: clock.setInterval.bind(clock) as any,
    clearInterval: clock.clearInterval.bind(clock) as any,
  });
  return { fsm, ws, clock, states };
};

// Microtask flush: handleDisconnect is async (probe + respawn). Tests need to
// await one settle pass after emitting "close" before asserting on fsm.state.
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

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

describe("ReconnectFSM daemon-died handling (VOS-120)", () => {
  test("probe-fail after WS close spends auto-respawn budget exactly once", async () => {
    let respawnCalls = 0;
    let probeCalls = 0;
    const { fsm, ws } = makeDaemonFsm({
      probe: async () => {
        probeCalls++;
        throw new Error("ECONNREFUSED");
      },
      respawn: async () => { respawnCalls++; },
    });
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    await flush();
    expect(probeCalls).toBe(1);
    expect(respawnCalls).toBe(1);
    expect(fsm.state).toBe("connecting");
  });

  test("second crash without budget reset goes to manual-restart, no respawn", async () => {
    let respawnCalls = 0;
    const { fsm, ws } = makeDaemonFsm({
      probe: async () => { throw new Error("ECONNREFUSED"); },
      respawn: async () => { respawnCalls++; },
    });
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    await flush();
    expect(respawnCalls).toBe(1);
    // Re-connect, then crash again without 5min stable window.
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    await flush();
    expect(respawnCalls).toBe(1);
    expect(fsm.state).toBe("manual-restart");
  });

  test("probe success means WS dropped (not daemon dead) — normal retry loop", async () => {
    let respawnCalls = 0;
    const { fsm, ws, clock } = makeDaemonFsm({
      probe: async () => ({ ok: true, port: 7777, vault_root: "/V", version: "0.1" }),
      respawn: async () => { respawnCalls++; },
    });
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    await flush();
    expect(respawnCalls).toBe(0);
    expect(fsm.state).toBe("reconnecting");
    clock.advance(2000);
    expect(ws.opened).toBe(2);
  });

  test("5min stable connection resets auto-respawn budget", async () => {
    let respawnCalls = 0;
    const { fsm, ws, clock } = makeDaemonFsm({
      probe: async () => { throw new Error("ECONNREFUSED"); },
      respawn: async () => { respawnCalls++; },
      stableResetMs: 1000, // short for test
    });
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    await flush();
    expect(respawnCalls).toBe(1);

    // Reconnect; stay stable for >stableResetMs; then crash again — budget reset.
    ws.emit({ kind: "hello", version: "0.1.0" });
    clock.advance(1500);
    ws.emit({ kind: "close" });
    await flush();
    expect(respawnCalls).toBe(2);
    expect(fsm.state).toBe("connecting");
  });

  test("resetAutoRespawn() clears budget so next crash gets a fresh respawn", async () => {
    let respawnCalls = 0;
    const { fsm, ws } = makeDaemonFsm({
      probe: async () => { throw new Error("ECONNREFUSED"); },
      respawn: async () => { respawnCalls++; },
    });
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    await flush();
    expect(respawnCalls).toBe(1);

    fsm.resetAutoRespawn();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    await flush();
    expect(respawnCalls).toBe(2);
    expect(fsm.state).toBe("connecting");
  });

  test("respawn failure surfaces as manual-restart", async () => {
    const { fsm, ws } = makeDaemonFsm({
      probe: async () => { throw new Error("ECONNREFUSED"); },
      respawn: async () => { throw new Error("spawn failed"); },
    });
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    await flush();
    expect(fsm.state).toBe("manual-restart");
  });

  test("FSM without probeHealth dep behaves as pre-VOS-120 (backward-compat)", () => {
    // makeFsm() builds an FSM without probeHealth/respawn — covered by the
    // pre-existing close→retry test above; assertion here is just a sanity:
    const { fsm, ws, clock } = makeFsm();
    fsm.start();
    ws.emit({ kind: "hello", version: "0.1.0" });
    ws.emit({ kind: "close" });
    clock.advance(2000);
    expect(ws.opened).toBe(2); // straight to retry, no probe in path
  });
});
