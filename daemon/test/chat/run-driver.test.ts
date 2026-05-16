import { describe, it, expect } from "bun:test";
import { drainRun, mergeAdjacentText } from "../../src/chat/run-driver.ts";
import type { ProviderHandle } from "../../src/providers/types.ts";
import type { Part } from "../../src/types/a2a.ts";

function makeHandle(events: AsyncIterable<any>, done: ProviderHandle["done"]): ProviderHandle {
  return { events, cancel: async () => true, done };
}

describe("run-driver: happy path", () => {
  it("accumulates parts and returns merged outcome.parts", async () => {
    async function* gen() {
      yield { type: "parts", role: "ROLE_AGENT",
        parts: [{ text: "hello" }] as Part[], ts: 1 };
      yield { type: "parts", role: "ROLE_AGENT",
        parts: [{ text: " world" }] as Part[], ts: 2 };
    }
    const handle = makeHandle(gen(),
      Promise.resolve({ reason: "exit" as const, exitCode: 0 }));
    const outcome = await drainRun({ handle });
    expect(outcome.reason).toBe("exit");
    expect(outcome.firstAssistantSeen).toBe(true);
    expect(outcome.parts).toEqual([{ text: "hello world" }]); // merged
  });
});

describe("run-driver: onSession", () => {
  it("fires for session event with sessionId", async () => {
    async function* gen() {
      yield { type: "session", sessionId: "sess-abc" };
      yield { type: "parts", role: "ROLE_AGENT", parts: [{ text: "x" }], ts: 1 };
    }
    const handle = makeHandle(gen(), Promise.resolve({ reason: "exit" as const }));
    const seen: string[] = [];
    await drainRun({ handle, onSession: (s) => seen.push(s) });
    expect(seen).toEqual(["sess-abc"]);
  });
});

describe("run-driver: onPart", () => {
  it("fires once per parts event with concatenated frameText", async () => {
    async function* gen() {
      yield { type: "parts", role: "ROLE_AGENT",
        parts: [{ text: "a" }, { text: "b" },
                { data: { kind: "tool_use", tool_call_id: "x" } }], ts: 1 };
    }
    const handle = makeHandle(gen(), Promise.resolve({ reason: "exit" as const }));
    const frames: any[] = [];
    await drainRun({ handle, onPart: (f) => frames.push(f) });
    expect(frames).toHaveLength(1);
    expect(frames[0].frameText).toBe("ab");
    expect(frames[0].parts).toHaveLength(3);
  });
});

describe("mergeAdjacentText", () => {
  it("merges consecutive TextParts", () => {
    const out = mergeAdjacentText([{ text: "a" }, { text: "b" },
                                    { data: { kind: "x" } } as any, { text: "c" }]);
    expect(out).toEqual([{ text: "ab" }, { data: { kind: "x" } } as any, { text: "c" }]);
  });
});

describe("run-driver: bounded cancel", () => {
  it("resolves within 50ms of signal.abort() even if handle.done never resolves", async () => {
    async function* gen() {
      yield { type: "parts", role: "ROLE_AGENT", parts: [{ text: "x" }], ts: 1 };
      await new Promise(() => {});  // generator stays open forever
    }
    const neverDone = new Promise<{ reason: "exit" }>(() => {});
    const handle: any = { events: gen(), cancel: async () => true, done: neverDone };
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 5);
    const outcome = await drainRun({ handle, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(50);
    expect(outcome.reason).toBe("cancel");
    expect(outcome.parts).toEqual([{ text: "x" }]);  // buffer preserved in outcome
  });
});

describe("run-driver: iterator close on cancel", () => {
  it("generator's finally block fires after signal.abort()", async () => {
    let finallyFired = false;
    const ac = new AbortController();
    async function* gen() {
      try {
        yield { type: "parts", role: "ROLE_AGENT", parts: [{ text: "x" }], ts: 1 };
        // Cooperative producer: poll the signal so cancellation can land.
        while (!ac.signal.aborted) {
          await new Promise((r) => setTimeout(r, 1));
        }
      } finally {
        finallyFired = true;
      }
    }
    const neverDone = new Promise<{ reason: "exit" }>(() => {});
    const handle: any = { events: gen(), cancel: async () => true, done: neverDone };
    setTimeout(() => ac.abort(), 5);
    await drainRun({ handle, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 30)); // microtask + timer flush
    expect(finallyFired).toBe(true);
  });
});

describe("run-driver: warn on stuck handle.done", () => {
  it("calls console.warn with [run-driver] prefix when abortSentinel wins", async () => {
    async function* gen() {
      yield { type: "parts", role: "ROLE_AGENT", parts: [{ text: "x" }], ts: 1 };
      await new Promise(() => {});
    }
    const neverDone = new Promise<{ reason: "exit" }>(() => {});
    const handle: any = { events: gen(), cancel: async () => true, done: neverDone };
    const ac = new AbortController();
    const warnSpy: any[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warnSpy.push(args); };
    try {
      setTimeout(() => ac.abort(), 5);
      await drainRun({ handle, signal: ac.signal });
    } finally { console.warn = origWarn; }
    expect(warnSpy.some((a) =>
      String(a[0]).includes("[run-driver]"))).toBe(true);
  });
});

describe("run-driver: no warn when handle.done resolves on cancel", () => {
  it("does not warn when handle.done resolves with cancel before sentinel", async () => {
    async function* gen() {
      yield { type: "parts", role: "ROLE_AGENT", parts: [{ text: "x" }], ts: 1 };
      while (true) { await new Promise((r) => setTimeout(r, 1)); }
    }
    const ac = new AbortController();
    // handle.done resolves cleanly when cancel is observed — well-behaved provider.
    const done = new Promise<{ reason: "cancel" }>((resolve) => {
      ac.signal.addEventListener("abort", () => resolve({ reason: "cancel" }), { once: true });
    });
    const handle: any = { events: gen(), cancel: async () => true, done };
    const warnSpy: any[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warnSpy.push(args); };
    try {
      setTimeout(() => ac.abort(), 5);
      await drainRun({ handle, signal: ac.signal });
    } finally { console.warn = origWarn; }
    expect(warnSpy.some((a) => String(a[0]).includes("[run-driver]"))).toBe(false);
  });
});

describe("run-driver: terminal reasons", () => {
  for (const reason of ["exit", "cancel", "timeout", "error"] as const) {
    it(`propagates ${reason}`, async () => {
      async function* gen() {}
      const handle = makeHandle(gen(), Promise.resolve({ reason }));
      const outcome = await drainRun({ handle });
      expect(outcome.reason).toBe(reason);
    });
  }
});

it("firstAssistantSeen is false when no ROLE_AGENT parts event fires", async () => {
  async function* gen() {
    yield { type: "parts", role: "ROLE_USER", parts: [{ text: "hi" }], ts: 1 };
  }
  const handle = makeHandle(gen(), Promise.resolve({ reason: "exit" as const }));
  const outcome = await drainRun({ handle });
  expect(outcome.firstAssistantSeen).toBe(false);
});
