// Queue + flush integration (VOS-80 reframe).
//
// Spec:
//   - Composer is always enabled.
//   - Send while runState==="running" → enqueue, NO postMessage.
//   - "↻ queued" badge appears in the UI for the queued bubble.
//   - On run.end (any status) flush head → POST + queued bubble loses badge.
//   - On chat switch, only active chat's queue is visible.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot queue + flush (VOS-80)", () => {
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

  test("composer is always enabled (textarea not disabled even while running)", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage() { return { run_id: "r1", status: "running" }; },
      async cancel() { return { run_id: "rX", status: "cancelled" }; },
      async listChats() { return []; },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", agentsApi: { listAgents: async () => [] }, openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush(act);

    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.disabled).toBe(false);
    expect(ta.readOnly).toBe(false);

    root.unmount();
  });

  test("send while running enqueues (no postMessage), shows queued badge, flushes on run.end", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const postCalls: { id: string; text: string }[] = [];
    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage(id: string, text: string) {
        postCalls.push({ id, text });
        return { run_id: "r2", status: "running" };
      },
      async cancel() { return { run_id: "rX", status: "cancelled" }; },
      async listChats() { return []; },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", agentsApi: { listAgents: async () => [] }, openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    // Simulate a run already streaming (e.g. opened the chat mid-run).
    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush(act);

    // User sends "queued one" via the test-send hook.
    await act(async () => {
      (globalThis as any).window.dispatchEvent(
        new (globalThis as any).window.CustomEvent("vos-test-send", {
          detail: { text: "queued one" },
        }),
      );
    });
    await flush(act);

    // No POST yet.
    expect(postCalls).toEqual([]);

    // Queued badge present + body visible.
    expect(host.textContent).toContain("↻ queued");
    expect(host.textContent).toContain("queued one");

    // Send a second message — also queued.
    await act(async () => {
      (globalThis as any).window.dispatchEvent(
        new (globalThis as any).window.CustomEvent("vos-test-send", {
          detail: { text: "queued two" },
        }),
      );
    });
    await flush(act);
    expect(postCalls).toEqual([]);
    expect(host.textContent).toContain("queued two");

    // run.end (status:cancelled, like ESC path) → flush head ("queued one").
    await act(async () => {
      bus.emit({ type: "run.end", chat_id: "c1", run_id: "r1", status: "cancelled" });
    });
    await flush(act);

    expect(postCalls.length).toBe(1);
    expect(postCalls[0]).toEqual({ id: "c1", text: "queued one" });

    // After flush of "queued one": "queued one" no longer has the badge,
    // but "queued two" still does (still queued, waiting for next run.end).
    // We assert the badge count is exactly 1 (only "queued two").
    const badges = host.querySelectorAll("[data-testid='queued-badge']");
    expect(badges.length).toBe(1);
    expect(host.textContent).toContain("queued two");

    root.unmount();
  });

  test("queue does not flush a second time without a fresh run.start (no double-send)", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const postCalls: { id: string; text: string }[] = [];
    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage(id: string, text: string) {
        postCalls.push({ id, text });
        return { run_id: "rN", status: "running" };
      },
      async cancel() { return { run_id: "rX", status: "cancelled" }; },
      async listChats() { return []; },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", agentsApi: { listAgents: async () => [] }, openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush(act);

    await act(async () => {
      (globalThis as any).window.dispatchEvent(
        new (globalThis as any).window.CustomEvent("vos-test-send", {
          detail: { text: "q1" },
        }),
      );
      (globalThis as any).window.dispatchEvent(
        new (globalThis as any).window.CustomEvent("vos-test-send", {
          detail: { text: "q2" },
        }),
      );
    });
    await flush(act);
    expect(postCalls).toEqual([]);

    // First run ends — flush head q1.
    await act(async () => {
      bus.emit({ type: "run.end", chat_id: "c1", run_id: "r1", status: "done" });
    });
    await flush(act);
    expect(postCalls.length).toBe(1);
    expect(postCalls[0].text).toBe("q1");

    // No further run.start arrives (daemon failed to start the new run, say).
    // q2 should NOT be flushed automatically — we only flush on the next
    // running→!running transition.
    expect(postCalls.length).toBe(1);

    // Now run.start + run.end for the q1 flush — q2 should flush.
    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r2", agent: "maya" });
    });
    await flush(act);
    await act(async () => {
      bus.emit({ type: "run.end", chat_id: "c1", run_id: "r2", status: "done" });
    });
    await flush(act);
    expect(postCalls.length).toBe(2);
    expect(postCalls[1].text).toBe("q2");

    root.unmount();
  });
});
