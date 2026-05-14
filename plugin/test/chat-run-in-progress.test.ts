// S5: inline "run in progress" 409 surface under composer.
//
// When POST /chat/:id/message returns 409 with body
// {error:"run_in_progress", current_run_id}, the runtime currently throws
// ApiError. We now want ChatRoot to surface a small inline row beneath the
// composer with the text "Run in progress — wait or cancel". The row should
// auto-clear when run.end or run.error arrives for the current chat, and
// when the user switches chats.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot inline 409 run-in-progress notice (S5)", () => {
  beforeAll(() => {
    const win = new Window();
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
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

  const NOTICE = "Run in progress — wait or cancel";

  // Helper: 20 microtask drains, same pattern as chat-runtime.test.ts.
  const flush = async (act: any) => {
    for (let i = 0; i < 20; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
  };

  test("shows inline notice after 409 from postMessage", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ApiError } = await import("../src/chat/api");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage(_id: string, _text: string) {
        throw new ApiError(409, { error: "run_in_progress", current_run_id: "r-other" });
      },
      async listChats() { return []; },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1" }));
    });
    await flush(act);

    // Drive an onNew via the runtime. We can't easily hit the composer's
    // keyboard path under happy-dom, so we trigger the runtime through a
    // synthetic event the same way assistant-ui would: by calling postMessage
    // directly through the api, and asserting the surface reacts to a 409
    // we emit on the bus instead. But the spec is clearer if we exercise the
    // real path. Simplest: dispatch a custom event the ChatRoot listens to.
    //
    // Instead of plumbing a custom event, we expose the runtime's onNew via
    // a test hook: ChatRoot listens for a window event "vos-test-send" that
    // forwards to the runtime's append. This keeps the production path
    // untouched outside the test gate (handler is no-op if event never fires).
    await act(async () => {
      (globalThis as any).window.dispatchEvent(
        new (globalThis as any).window.CustomEvent("vos-test-send", { detail: { text: "hi" } }),
      );
    });
    await flush(act);

    expect(host.textContent).toContain(NOTICE);

    // run.end clears it
    await act(async () => {
      bus.emit({ type: "run.end", chat_id: "c1", run_id: "r-other", status: "done" });
    });
    await flush(act);

    expect(host.textContent).not.toContain(NOTICE);

    root.unmount();
  });

  test("notice clears when switching chats", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ApiError } = await import("../src/chat/api");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage(_id: string, _text: string) {
        throw new ApiError(409, { error: "run_in_progress", current_run_id: "r-other" });
      },
      async listChats() {
        return [
          { id: "c1", agent: "maya", title: "A", last_msg: "x", updated_at: 2, last_run_status: "running" },
          { id: "c2", agent: "maya", title: "B", last_msg: "y", updated_at: 1, last_run_status: "done" },
        ];
      },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1" }));
    });
    await flush(act);

    await act(async () => {
      (globalThis as any).window.dispatchEvent(
        new (globalThis as any).window.CustomEvent("vos-test-send", { detail: { text: "hi" } }),
      );
    });
    await flush(act);
    expect(host.textContent).toContain(NOTICE);

    // Switch chats by clicking another row.
    const rows = host.querySelectorAll("[data-testid='chat-row']");
    const c2 = Array.from(rows).find((el: any) => el.getAttribute("data-chat-id") === "c2");
    expect(c2).toBeTruthy();
    await act(async () => { (c2 as any).click(); });
    await flush(act);

    expect(host.textContent).not.toContain(NOTICE);
    root.unmount();
  });
});
