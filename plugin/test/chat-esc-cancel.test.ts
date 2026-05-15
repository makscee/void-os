// ESC-to-cancel + ESC hint visibility (VOS-80 reframe).
//
// Spec:
//   - When composer textarea is focused AND runState === "running",
//     pressing ESC calls POST /chat/:id/cancel.
//   - Composer focused + idle → ESC is a no-op (don't call cancel).
//   - Textarea NOT focused → ESC is a no-op (don't steal ESC globally).
//   - ESC hint ("ESC to interrupt") is only visible while running.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot ESC handler + hint (VOS-80)", () => {
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

  test("ESC hint hidden when idle; ESC on textarea does NOT call cancel", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    let cancelCalls = 0;
    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage(_id: string, _text: string) {
        return { run_id: "r1", status: "running" };
      },
      async cancel(_id: string) {
        cancelCalls++;
        return { run_id: "rX", status: "cancelled" };
      },
      async listChats() { return []; },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    // Hint is NOT visible in idle state.
    expect(host.querySelector("[data-testid='esc-hint']")).toBeNull();

    // Fire ESC on the textarea (key 'Escape').
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    await act(async () => {
      const ev = new (globalThis as any).window.KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      });
      ta.dispatchEvent(ev);
    });
    await flush(act);
    expect(cancelCalls).toBe(0);

    root.unmount();
  });

  test("ESC on textarea while running → cancel called; hint visible", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    let cancelCalls = 0;
    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage(_id: string, _text: string) {
        return { run_id: "r1", status: "running" };
      },
      async cancel(_id: string) {
        cancelCalls++;
        return { run_id: "rX", status: "cancelled" };
      },
      async listChats() { return []; },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    // Drive a run.start so isRunning flips true.
    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush(act);

    // Hint is visible.
    const hint = host.querySelector("[data-testid='esc-hint']");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("ESC to interrupt");

    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const ev = new (globalThis as any).window.KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      });
      ta.dispatchEvent(ev);
    });
    await flush(act);

    expect(cancelCalls).toBe(1);

    root.unmount();
  });

  test("ESC outside textarea (on body) does NOT call cancel even when running", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    let cancelCalls = 0;
    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage(_id: string, _text: string) {
        return { run_id: "r1", status: "running" };
      },
      async cancel(_id: string) {
        cancelCalls++;
        return { run_id: "rX", status: "cancelled" };
      },
      async listChats() { return []; },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush(act);

    // Fire ESC at the body (outside the composer wrapper entirely).
    await act(async () => {
      const ev = new (globalThis as any).window.KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      });
      (globalThis as any).document.body.dispatchEvent(ev);
    });
    await flush(act);

    expect(cancelCalls).toBe(0);

    root.unmount();
  });

  test("cancel handles 409 noActiveRun gracefully (does not throw)", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage(_id: string, _text: string) {
        return { run_id: "r1", status: "running" };
      },
      async cancel(_id: string) {
        return { noActiveRun: true as const };
      },
      async listChats() { return []; },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush(act);

    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    let threw = false;
    try {
      await act(async () => {
        const ev = new (globalThis as any).window.KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true,
        });
        ta.dispatchEvent(ev);
      });
      await flush(act);
    } catch { threw = true; }
    expect(threw).toBe(false);

    root.unmount();
  });
});
