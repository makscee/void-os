// VOS-140 regression guard: per-frame flushSync defeats React batching so the
// user sees tokens land incrementally during the stream.
//
// Bug: React 18/19 automatic batching collapses successive `chat.token`
// dispatches (arriving in the same microtask burst from the daemon WS) into a
// single commit, so the assistant bubble jumps from empty → full instead of
// streaming. Fix: the bus subscriber in `useChatRuntime` wraps streaming
// frame dispatches (`chat.token`, `chat.tool_use`, `chat.tool_result`) in
// `flushSync(() => dispatch(...))`.
//
// Test approach: this spec mounts a tiny harness component that exposes
// `useChatRuntime`'s reducer state (`liveTokens`) into the DOM and tracks
// the number of render commits. We run OUTSIDE React's act() environment so
// flushSync behaves the way it does in production (forces synchronous commit
// rather than routing through the act scheduler). We emit three chat.token
// frames in immediate sequence with NO awaits between them, and snapshot
// the harness DOM + render count after each emission.
//
// With the flushSync patch:
//   - each snapshot reflects the partial concatenation up to that point
//   - the render counter increments at least three times across the burst
//
// Without the patch (regression):
//   - the first two snapshots show stale state (empty / "xqz")
//   - the counter increments only once across the burst (single batched commit)

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("useChatRuntime per-frame flushSync (VOS-140 regression)", () => {
  beforeAll(() => {
    const win = new Window();
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
    (win as any).SyntaxError = SyntaxError;
    // Run OUTSIDE act(): flushSync is a no-op + warns under
    // IS_REACT_ACT_ENVIRONMENT=true, which would mask the bug.
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const makeApi = () => ({
    async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
    async postMessage() { return { run_id: "r1", status: "running" }; },
    async cancel() { return { run_id: "rX", status: "cancelled" }; },
    async listChats() { return []; },
    async getMessages() { return []; },
    async getCostToday() { return { total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 } }; },
  });

  test("three chat.token frames in one burst → per-frame commits", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { FrameBus } = await import("../src/chat/bus");
    const { useChatRuntime } = await import("../src/chat/runtime");

    const bus = new FrameBus();
    const api = makeApi();
    let renderCount = 0;

    function Harness() {
      renderCount += 1;
      const handle = useChatRuntime({
        bus,
        api: api as any,
        chatId: "c1",
      });
      return React.createElement(
        "div",
        null,
        React.createElement("span", { id: "tokens" }, handle.chatState.liveTokens ?? ""),
        React.createElement("span", { id: "running" }, String(handle.isRunning)),
      );
    }

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    root.render(React.createElement(Harness));
    await drain();

    const tokensEl = () => host.querySelector("#tokens") as Element | null;

    // Begin streaming. run.start is non-streaming — drain so the running
    // state lands before the burst.
    bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    await drain();
    expect(host.querySelector("#running")?.textContent).toBe("true");

    const T1 = "xqz";
    const T2 = "wmf";
    const T3 = "ptl";

    expect(tokensEl()?.textContent ?? "").toBe("");
    const renderCountBeforeBurst = renderCount;

    // Emit three streaming frames synchronously, snapshotting DOM after
    // each. With flushSync each emit forces a synchronous commit.
    bus.emit({ type: "chat.token", chat_id: "c1", run_id: "r1", delta: T1 });
    const after1 = tokensEl()?.textContent ?? "";
    bus.emit({ type: "chat.token", chat_id: "c1", run_id: "r1", delta: T2 });
    const after2 = tokensEl()?.textContent ?? "";
    bus.emit({ type: "chat.token", chat_id: "c1", run_id: "r1", delta: T3 });
    const after3 = tokensEl()?.textContent ?? "";

    const renderCountAfterBurst = renderCount;

    // Partial concatenations must be visible mid-burst.
    expect(after1).toBe(T1);
    expect(after2).toBe(T1 + T2);
    expect(after3).toBe(T1 + T2 + T3);

    // Render committed at least once per frame. Without flushSync,
    // React would coalesce all three dispatches into one commit
    // (renderCountAfterBurst - renderCountBeforeBurst === 1).
    expect(renderCountAfterBurst - renderCountBeforeBurst).toBeGreaterThanOrEqual(3);

    await drain();
    expect(tokensEl()?.textContent ?? "").toBe(T1 + T2 + T3);

    root.unmount();
  });
});
