// VOS-80 — ESC cancel optimistic flip + "↯ stopped" badge.
//
// The live bug this guards: ESC POST 200 returned but the plugin's runState
// stayed "running" until the WS run.end roundtrip OR a chat switch. The fix
// dispatches a local_cancel action on cancel success, flipping the UI
// immediately. We assert:
//   - On ESC while running, after the cancel POST resolves, the ESC hint
//     and 3-dot pulse disappear EVEN BEFORE any run.end frame fires.
//   - The "↯ stopped" badge appears on the in-flight assistant turn.
//   - The eventual run.end{cancelled} frame is idempotent — badge stays,
//     no double-cancelled flag flip, runState stays idle.
//   - Partial assistant text streamed before ESC is preserved.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot ESC optimistic cancel (VOS-80)", () => {
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

  test("ESC → cancel POST 200 → runState flips idle BEFORE run.end frame arrives", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    // VOS-80 part 2: getMessages becomes the canonical history source after
    // run.end. The first call (mount) returns empty; after the cancel-driven
    // run.end the refetch yields the partial assistant turn the daemon
    // persisted (under VOS-80 part 1's messages-table contract).
    let getCalls = 0;
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage() { return { run_id: "r1", status: "running" }; },
      async cancel() {
        return { run_id: "r1", status: "cancelled" as const };
      },
      async listChats() { return []; },
      async getMessages() {
        getCalls += 1;
        if (getCalls === 1) return [];
        return [{ role: "assistant" as const, content: "partial reply" }];
      },
      async getCostToday() { return { total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 } }; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatRoot, { bus, api, chatId: "c1", openPicker: async () => ({ name: "maya", description: "test" }) }));
    });
    await flush(act);

    // Start a run + stream a partial token.
    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush(act);
    await act(async () => {
      bus.emit({ type: "chat.token", chat_id: "c1", run_id: "r1", delta: "partial reply" });
    });
    await flush(act);

    // Pre-condition: pulse + ESC hint visible.
    expect(host.querySelector("[data-testid='esc-hint']")).toBeTruthy();
    expect(host.querySelector("[aria-label='thinking']")).toBeTruthy();
    expect(host.textContent).toContain("partial reply");

    // Press ESC on the textarea — the cancel POST resolves WITHOUT us emitting
    // a run.end frame on the bus. The optimistic local_cancel must flip
    // runState to idle right away.
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const ev = new (globalThis as any).window.KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      });
      ta.dispatchEvent(ev);
    });
    await flush(act);

    // CRITICAL: indicators gone WITHOUT a run.end having arrived from the bus.
    expect(host.querySelector("[data-testid='esc-hint']")).toBeNull();
    expect(host.querySelector("[aria-label='thinking']")).toBeNull();
    // Partial text preserved.
    expect(host.textContent).toContain("partial reply");
    // "↯ stopped" badge present.
    expect(host.querySelector("[data-testid='stopped-badge']")).toBeTruthy();
    expect(host.textContent).toContain("stopped");

    // Now simulate the late run.end{cancelled} from the daemon — idempotent.
    await act(async () => {
      bus.emit({ type: "run.end", chat_id: "c1", run_id: "r1", status: "cancelled" });
    });
    await flush(act);

    expect(host.querySelector("[data-testid='stopped-badge']")).toBeTruthy();
    expect(host.querySelector("[data-testid='esc-hint']")).toBeNull();
    expect(host.textContent).toContain("partial reply");

    root.unmount();
  });

  test("normal done path (run.end{done}) does NOT show stopped badge", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    // getMessages: empty on mount, canonical assistant turn after run.end.
    let getCalls = 0;
    const api = {
      async createChat() { return { id: "c1", title: "t", created_at: 0 }; },
      async postMessage() { return { run_id: "r1", status: "running" }; },
      async cancel() { return { run_id: "r1", status: "cancelled" as const }; },
      async listChats() { return []; },
      async getMessages() {
        getCalls += 1;
        if (getCalls === 1) return [];
        return [{ role: "assistant" as const, content: "done answer" }];
      },
      async getCostToday() { return { total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 } }; },
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
      bus.emit({ type: "chat.token", chat_id: "c1", run_id: "r1", delta: "done answer" });
      bus.emit({ type: "run.end", chat_id: "c1", run_id: "r1", status: "done" });
    });
    await flush(act);

    expect(host.querySelector("[data-testid='stopped-badge']")).toBeNull();
    expect(host.querySelector("[data-testid='esc-hint']")).toBeNull();
    expect(host.textContent).toContain("done answer");
    expect(host.textContent).not.toContain("↯ stopped");

    root.unmount();
  });
});
