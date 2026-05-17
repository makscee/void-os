// VOS-80 — inline error notice on run.end{status:"error"}.
//
// Two failure-mode visual cues distinct from the cancel "↯ stopped" badge:
//
//   - timeout-notice: "Claude didn't respond. Try again."
//     Fired when the daemon's first_event/output/tool watchdog stamped a
//     timeout error string on run.end.
//   - error-notice: generic "Something went wrong. Try again."
//     Fired when run.end{status:"error"} carries a non-timeout error.
//
// Both notices clear on the next run.start (user retry).

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot inline error notice (VOS-80)", () => {
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

  const baseApi = () => ({
    async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
    async postMessage() { return { run_id: "r1", status: "running" }; },
    async cancel() { return { run_id: "r1", status: "cancelled" as const }; },
    async listChats() { return []; },
    async getMessages() { return [] as any[]; },
    async getCostToday() { return { total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 } }; },
  });

  test("run.end{error: timeout} renders timeout notice in place of assistant reply", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = baseApi();

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
      bus.emit({
        type: "run.end", chat_id: "c1", run_id: "r1",
        status: "error",
        error: "watchdog timeout (phase=first_event idle=15000)",
      });
    });
    await flush(act);

    expect(host.querySelector("[data-testid='timeout-notice']")).toBeTruthy();
    expect(host.textContent).toContain("Claude didn");
    expect(host.textContent).toContain("Try again");
    // Stopped badge must NOT show — this is a daemon error, not a cancel.
    expect(host.querySelector("[data-testid='stopped-badge']")).toBeNull();
    expect(host.querySelector("[data-testid='error-notice']")).toBeNull();

    root.unmount();
  });

  test("run.end{error: other} renders generic error notice", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = baseApi();

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
      bus.emit({
        type: "run.end", chat_id: "c1", run_id: "r1",
        status: "error",
        error: "permission denied",
      });
    });
    await flush(act);

    expect(host.querySelector("[data-testid='error-notice']")).toBeTruthy();
    expect(host.textContent).toContain("Something went wrong");
    expect(host.querySelector("[data-testid='timeout-notice']")).toBeNull();

    root.unmount();
  });

  test("notice clears on the next run.start (user retry)", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = baseApi();

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
      bus.emit({
        type: "run.end", chat_id: "c1", run_id: "r1",
        status: "error", error: "first_event timeout",
      });
    });
    await flush(act);
    expect(host.querySelector("[data-testid='timeout-notice']")).toBeTruthy();

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r2", agent: "maya" });
    });
    await flush(act);
    expect(host.querySelector("[data-testid='timeout-notice']")).toBeNull();

    root.unmount();
  });
});
