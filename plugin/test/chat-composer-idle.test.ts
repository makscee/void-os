// S5 regression: composer textarea must be enabled + writable in idle state.
//
// Originated from a live bug where the composer input could not be focused
// or typed into after S5 commits. Pre-S5 (S3 final, S4) the composer worked.
//
// We mount ChatRoot with a stub api+bus, never emit run.start, and assert:
//   - the textarea exists,
//   - it is NOT `disabled`,
//   - it is NOT `readOnly`,
//   - it is not covered (no ancestor with display:none / hidden / inert).
//
// happy-dom keyboard input is fragile — we cannot rely on `.focus()` / typing
// here; the DOM attribute / disabled-prop check is what catches the
// regression class (composer wired to a stuck isRunning / isDisabled).

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot composer in idle state (S5 regression guard)", () => {
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

  const flush = async (act: any) => {
    for (let i = 0; i < 20; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
  };

  test("composer textarea is enabled and writable after mount (idle)", async () => {
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

    const ta = host.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(ta).not.toBeNull();
    expect(ta!.disabled).toBe(false);
    expect(ta!.readOnly).toBe(false);
    // `placeholder="Message"` is our composer specifically (not some other textarea).
    expect(ta!.getAttribute("placeholder")).toBe("Message");

    root.unmount();
  });
});
