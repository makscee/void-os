import { describe, expect, test } from "bun:test";
import { createWatchdog } from "../src/providers/claude-code/watchdog.js";

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
      firstEventTimeoutMs: 10_000,
      startedAt: clock.now(),
      lastEventTs: () => clock.now(),  // never idle (also implies first event seen)
      inToolCall: () => 0,
      onTimeout: () => { fired = true; },
    });
    wd.tick(); wd.tick(); wd.tick();
    expect(fired).toBe(false);
  });

  test("fires when idle exceeds outputTimeoutMs in non-tool state", () => {
    const clock = makeClock();
    const lastEvent = clock.now();
    let fired: { idleMs: number; threshold: number; phase: string } | undefined;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 500,
      toolTimeoutMs: 30_000,
      firstEventTimeoutMs: 10_000,
      startedAt: clock.now() - 1, // already past start, first event already seen
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
    expect(fired!.phase).toBe("output");
  });

  test("uses toolTimeoutMs when inToolCall() > 0", () => {
    const clock = makeClock();
    const lastEvent = clock.now();
    let fired: { idleMs: number; threshold: number; phase: string } | undefined;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 500,
      toolTimeoutMs: 5_000,
      firstEventTimeoutMs: 10_000,
      startedAt: clock.now() - 1,
      lastEventTs: () => lastEvent,
      inToolCall: () => 1,
      onTimeout: (info) => { fired = info; },
    });
    clock.advance(1_000); wd.tick();
    expect(fired).toBeUndefined();   // below toolTimeoutMs even though above outputTimeoutMs
    clock.advance(5_000); wd.tick();
    expect(fired).toBeDefined();
    expect(fired!.threshold).toBe(5_000);
    expect(fired!.phase).toBe("tool");
  });

  test("onTimeout fires at most once even if tick is called repeatedly", () => {
    const clock = makeClock();
    const lastEvent = clock.now();
    let count = 0;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 100,
      toolTimeoutMs: 100,
      firstEventTimeoutMs: 10_000,
      startedAt: clock.now() - 1,
      lastEventTs: () => lastEvent,
      inToolCall: () => 0,
      onTimeout: () => { count++; },
    });
    clock.advance(500);
    wd.tick(); wd.tick(); wd.tick();
    expect(count).toBe(1);
  });

  // VOS-80 fix: pre-first-event watchdog.
  // Reproduces the cancel-resume-hang failure mode: CC --resume against a
  // SIGINT-killed session stalls in claudev auth/setup and produces only
  // noise (banner lines), never a parsed stream-json event. Without the
  // fix, the user-facing indicator stays "running" for outputTimeoutMs
  // (120s) before the watchdog clears it; with the fix, firstEventTimeoutMs
  // (15s default) limits the visible hang.
  test("fires with phase='first_event' when no event ever arrives", () => {
    const clock = makeClock();
    let fired: { idleMs: number; threshold: number; phase: string } | undefined;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 120_000,  // long mid-stream ceiling — should NOT be used here
      toolTimeoutMs: 1_800_000,
      firstEventTimeoutMs: 1_000,
      startedAt: clock.now(),
      lastEventTs: () => 0,       // parser never saw an event
      inToolCall: () => 0,
      onTimeout: (info) => { fired = info; },
    });
    // Below firstEventTimeoutMs — no fire.
    clock.advance(900); wd.tick();
    expect(fired).toBeUndefined();
    // Past firstEventTimeoutMs — fires with the shorter threshold,
    // NOT the 120s outputTimeoutMs.
    clock.advance(200); wd.tick();
    expect(fired).toBeDefined();
    expect(fired!.phase).toBe("first_event");
    expect(fired!.threshold).toBe(1_000);
    expect(fired!.idleMs).toBeGreaterThanOrEqual(1_000);
  });

  test("first event arriving cancels the first_event phase", () => {
    const clock = makeClock();
    let lastEvent = 0;
    let fired: { phase: string } | undefined;
    const wd = createWatchdog({
      now: clock.now,
      outputTimeoutMs: 500,
      toolTimeoutMs: 30_000,
      firstEventTimeoutMs: 1_000,
      startedAt: clock.now(),
      lastEventTs: () => lastEvent,
      inToolCall: () => 0,
      onTimeout: (info) => { fired = info; },
    });
    // First event arrives well before firstEventTimeoutMs.
    clock.advance(200);
    lastEvent = clock.now();
    wd.tick();
    expect(fired).toBeUndefined();

    // Now in the post-first-event regime; should use outputTimeoutMs.
    clock.advance(400); wd.tick();
    expect(fired).toBeUndefined();
    clock.advance(200); wd.tick();    // idle now > 500
    expect(fired).toBeDefined();
    expect(fired!.phase).toBe("output");
  });
});
