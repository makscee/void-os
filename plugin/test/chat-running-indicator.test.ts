// VOS-80 regression guard: live "running" signal must reach assistant-ui.
//
// Bug history: after the composer-reframe commits, we passed
// `isRunning: false` (hardcoded) to useExternalStoreRuntime to avoid
// disabling the composer. That broke THREE things at once:
//   - the 3-dot thinking pulse stayed hidden during streaming
//     (gated on ThreadPrimitive.If running)
//   - the "ESC to interrupt" hint stayed hidden (well, this one is on
//     handle.isRunning which IS reactive — but kept as a sibling check)
//   - the live assistant bubble didn't render during the stream because
//     assistant-ui never created the optimistic-assistant scaffold (its
//     `hasUpcomingMessage` check needs isRunning to be true)
//
// This test mounts ChatRoot, emits run.start + chat.token frames on the bus,
// and asserts that the 3-dot pulse + ESC hint are visible AND the streamed
// assistant text appears in the DOM. It guards against any future re-drop
// of the isRunning signal.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot live run indicators (VOS-80 regression)", () => {
  beforeAll(() => {
    const win = new Window();
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
    (globalThis as any).KeyboardEvent = win.KeyboardEvent;
    (globalThis as any).ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
    (globalThis as any).MutationObserver = (globalThis as any).MutationObserver
      ?? class { observe(){} disconnect(){} takeRecords(){ return []; } };
    (win as any).SyntaxError = SyntaxError;
    const origDocQSA = (win.document as any).querySelectorAll.bind(win.document);
    (win.document as any).querySelectorAll = (sel: string) => {
      try { return origDocQSA(sel); } catch { return [] as any; }
    };
    (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) =>
      setTimeout(() => cb(Date.now()), 0) as any;
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  const flush = async (act: any) => {
    for (let i = 0; i < 20; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
  };

  const makeApi = () => {
    // VOS-80 part 2: post-run.end the runtime refetches GET /chat/:id/messages
    // to replace the live overlay with canonical state. First call (mount)
    // → empty; subsequent calls → canonical assistant turn containing the
    // streamed text. This lets the post-run assertion see "hello live" via
    // the refetched messages, not the (now-cleared) overlay.
    let calls = 0;
    return {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage() { return { run_id: "r1", status: "running" }; },
      async cancel() { return { run_id: "rX", status: "cancelled" }; },
      async listChats() { return []; },
      async getMessages() {
        calls += 1;
        if (calls === 1) return [];
        return [{ role: "assistant" as const, content: "hello live" }];
      },
    };
  };

  test("run.start + chat.token → pulse visible, ESC hint visible, streamed text in DOM", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api: makeApi(), chatId: "c1", agentsApi: { listAgents: async () => [] }, openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    // Idle baseline.
    expect(host.querySelector("[data-testid='esc-hint']")).toBeNull();
    expect(host.querySelector("[aria-label='thinking']")).toBeNull();

    // Begin streaming.
    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush(act);

    // ESC hint visible (handle.isRunning === true).
    expect(host.querySelector("[data-testid='esc-hint']")).toBeTruthy();
    // 3-dot pulse visible (gated by ThreadPrimitive.If running — requires
    // assistant-ui's internal isRunning to be true, which requires our
    // useExternalStoreRuntime({ isRunning }) to be reactive).
    expect(host.querySelector("[aria-label='thinking']")).toBeTruthy();

    // Stream a token — live assistant text must render in the DOM during
    // the run, not just after run.end.
    await act(async () => {
      bus.emit({ type: "chat.token", chat_id: "c1", run_id: "r1", delta: "hello live" });
    });
    await flush(act);

    expect(host.textContent).toContain("hello live");
    // Pulse + hint still visible while still running.
    expect(host.querySelector("[data-testid='esc-hint']")).toBeTruthy();
    expect(host.querySelector("[aria-label='thinking']")).toBeTruthy();

    // Run ends → both indicators disappear.
    await act(async () => {
      bus.emit({ type: "run.end", chat_id: "c1", run_id: "r1", status: "done" });
    });
    await flush(act);

    expect(host.querySelector("[data-testid='esc-hint']")).toBeNull();
    expect(host.querySelector("[aria-label='thinking']")).toBeNull();
    // Streamed text remains in the completed message.
    expect(host.textContent).toContain("hello live");

    root.unmount();
  });
});
