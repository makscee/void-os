import { describe, expect, test } from "bun:test";
import { createWatchdog } from "../src/adapters/cc/watchdog.js";

const makeClock = (start = 1_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) { now += ms; },
  };
};

describe("createWatchdog", () => {
  test("does not fire when idle stays below outputTimeoutMs in non-tool state", () => {
    const clock = makeClock();
    let fired = false;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 1000,
      toolTimeoutMs: 30_000,
      lastEventTs: () => clock.now(),  // never idle
      inToolCall: () => 0,
      onTimeout: () => { fired = true; },
    });
    wd.tick(); wd.tick(); wd.tick();
    expect(fired).toBe(false);
  });

  test("fires when idle exceeds outputTimeoutMs in non-tool state", () => {
    const clock = makeClock();
    let lastEvent = clock.now();
    let fired: { idleMs: number; threshold: number } | undefined;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 500,
      toolTimeoutMs: 30_000,
      lastEventTs: () => lastEvent,
      inToolCall: () => 0,
      onTimeout: (info) => { fired = info; },
    });
    clock.advance(400); wd.tick();
    expect(fired).toBeUndefined();
    clock.advance(200); wd.tick();
    expect(fired).toBeDefined();
    expect(fired!.threshold).toBe(500);
    expect(fired!.idleMs).toBeGreaterThanOrEqual(500);
  });

  test("uses toolTimeoutMs when inToolCall() > 0", () => {
    const clock = makeClock();
    const lastEvent = clock.now();
    let fired: { idleMs: number; threshold: number } | undefined;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 500,
      toolTimeoutMs: 5_000,
      lastEventTs: () => lastEvent,
      inToolCall: () => 1,
      onTimeout: (info) => { fired = info; },
    });
    clock.advance(1_000); wd.tick();
    expect(fired).toBeUndefined();   // below toolTimeoutMs even though above outputTimeoutMs
    clock.advance(5_000); wd.tick();
    expect(fired).toBeDefined();
    expect(fired!.threshold).toBe(5_000);
  });

  test("onTimeout fires at most once even if tick is called repeatedly", () => {
    const clock = makeClock();
    const lastEvent = clock.now();
    let count = 0;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 100,
      toolTimeoutMs: 100,
      lastEventTs: () => lastEvent,
      inToolCall: () => 0,
      onTimeout: () => { count++; },
    });
    clock.advance(500);
    wd.tick(); wd.tick(); wd.tick();
    expect(count).toBe(1);
  });
});
