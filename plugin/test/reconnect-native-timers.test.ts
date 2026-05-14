// Regression: ReconnectFSM must not invoke native browser timers with
// `this === FSM instance`. In Electron's renderer that throws
// "Illegal invocation". Reproduce by stubbing the global timer fns to throw
// when called with the wrong receiver, then ensuring the FSM (using NATIVE
// fallbacks — i.e. no injected timers) goes through hello → startPing without
// throwing.

import { describe, test, expect, afterEach } from "bun:test";
import { ReconnectFSM } from "../src/reconnect";
import { FakeWs } from "./fakes";
import type { ConnectionState } from "../src/state";

const g: any = globalThis;

describe("ReconnectFSM native timer binding", () => {
  const originals = {
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
  };

  afterEach(() => {
    g.setTimeout = originals.setTimeout;
    g.clearTimeout = originals.clearTimeout;
    g.setInterval = originals.setInterval;
    g.clearInterval = originals.clearInterval;
  });

  test("hello → startPing does not throw 'Illegal invocation' when using native fallbacks", () => {
    // Wrap natives so they throw if called with a non-global receiver.
    // This mirrors Electron's renderer behavior for browser-API timers.
    const guardReceiver = <F extends Function>(fn: F): F =>
      (function (this: any, ...args: any[]) {
        if (this !== g && this !== undefined) {
          throw new TypeError("Illegal invocation");
        }
        return (fn as any).apply(g, args);
      } as any);

    g.setTimeout = guardReceiver(originals.setTimeout);
    g.clearTimeout = guardReceiver(originals.clearTimeout);
    g.setInterval = guardReceiver(originals.setInterval);
    g.clearInterval = guardReceiver(originals.clearInterval);

    const ws = new FakeWs();
    const states: ConnectionState[] = [];
    // NOTE: deliberately omit setTimeout/etc. so the FSM uses native fallbacks.
    const fsm = new ReconnectFSM({
      client: ws,
      onState: (s) => states.push(s),
      retryMs: 2000,
      pingMs: 10000,
      pongTimeoutMs: 25000,
    });

    fsm.start();
    // The bug fires inside startPing → setI(...). It must not throw.
    expect(() => ws.emit({ kind: "hello", version: "0.1.0" })).not.toThrow();
    expect(states[states.length - 1]).toBe("connected");

    // Cleanup the live interval the FSM just armed against the (real) loop.
    fsm.stop();
  });

  test("injected timers still take precedence over native (mock-timer identity preserved)", () => {
    // Prove the bind() change does not bypass injected timers when callers
    // (the existing FakeClock-based tests) provide them.
    const calls: string[] = [];
    const fakeSetT = (_fn: () => void, _ms: number): any => { calls.push("setT"); return 1; };
    const fakeClrT = (_h: any): any => { calls.push("clrT"); };
    const fakeSetI = (_fn: () => void, _ms: number): any => { calls.push("setI"); return 2; };
    const fakeClrI = (_h: any): any => { calls.push("clrI"); };

    // Make natives throw to prove they are NOT touched.
    g.setTimeout = () => { throw new Error("native setTimeout used"); };
    g.clearTimeout = () => { throw new Error("native clearTimeout used"); };
    g.setInterval = () => { throw new Error("native setInterval used"); };
    g.clearInterval = () => { throw new Error("native clearInterval used"); };

    const ws = new FakeWs();
    const fsm = new ReconnectFSM({
      client: ws,
      onState: () => {},
      retryMs: 2000,
      pingMs: 10000,
      pongTimeoutMs: 25000,
      setTimeout: fakeSetT as any,
      clearTimeout: fakeClrT as any,
      setInterval: fakeSetI as any,
      clearInterval: fakeClrI as any,
    });

    fsm.start();
    expect(() => ws.emit({ kind: "hello", version: "0.1.0" })).not.toThrow();
    expect(calls).toContain("setI");
    fsm.stop();
    expect(calls).toContain("clrI");
  });
});
