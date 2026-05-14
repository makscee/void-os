// Runtime integration for S4: hydrate replay with mixed text + tool entries
// renders the right content parts; live tool_use/tool_result frames stream
// into the assistant turn; BashTool renders for toolName === "Bash" and the
// GenericTool fallback handles unknown tool names.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("ChatRoot tool UI (S4)", () => {
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
    // — wire the global in so the error path doesn't itself throw TypeError.
    (win as any).SyntaxError = SyntaxError;
    // react-textarea-autosize → getComputedStyle → querySelectorAll on
    // `@import` rule selectors that happy-dom rejects. Swallow and return [].
    const origDocQSA = (win.document as any).querySelectorAll.bind(win.document);
    (win.document as any).querySelectorAll = (sel: string) => {
      try { return origDocQSA(sel); } catch { return [] as any; }
    };
    (globalThis as any).requestAnimationFrame =
      (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0) as any;
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  test("hydrate replay with mixed text + tool entries renders tool block inline", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act as (cb: () => Promise<void> | void) => Promise<void>;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = {
      createChat: async () => ({ id: "c1", title: "t", created_at: 0 }),
      postMessage: async () => ({ run_id: "r", status: "running" }),
      listChats: async () => [],
      getMessages: async () => [
        { role: "user", content: "run ls please" },
        { role: "assistant", content: "running it" },
        {
          role: "tool_use",
          tool_call_id: "tu_h1",
          name: "Bash",
          input: { command: "ls -la" },
        },
        {
          role: "tool_result",
          tool_call_id: "tu_h1",
          output: "total 0\n",
          is_error: false,
        },
        { role: "assistant", content: "done" },
      ],
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ChatRoot as any, { bus, api, chatId: "c1" }));
    });

    // Drain rAF + microtasks for hydration + commit.
    for (let i = 0; i < 30; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }

    const html = host.innerHTML;
    expect(html).toContain("Bash");          // tool label visible
    expect(html).toContain("ls -la");        // command in <pre>
    expect(host.textContent).toContain("running it");
    expect(host.textContent).toContain("done");
    // Bash tool's wrapper has data-tool="Bash"
    expect(html).toContain('data-tool="Bash"');
    // After result, default collapsed → data-tool-state="done"
    expect(html).toContain('data-tool-state="done"');

    root.unmount();
  });

  test("live tool_use → tool_result frames render Bash block and collapse after completion", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act as (cb: () => Promise<void> | void) => Promise<void>;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = {
      createChat: async () => ({ id: "c1", title: "t", created_at: 0 }),
      postMessage: async () => ({ run_id: "r1", status: "running" }),
      listChats: async () => [],
      getMessages: async () => [],
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ChatRoot as any, { bus, api, chatId: "c1" }));
    });

    const flush = async () => {
      for (let i = 0; i < 25; i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      }
    };

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
    });
    await flush();
    await act(async () => {
      bus.emit({
        type: "chat.tool_use", chat_id: "c1", run_id: "r1",
        tool_call_id: "tu_l1", name: "Bash", input: { command: "echo hi" },
      });
    });
    await flush();
    // Running state → expanded (data-tool-state="running")
    expect(host.innerHTML).toContain('data-tool-state="running"');
    expect(host.innerHTML).toContain("echo hi");

    await act(async () => {
      bus.emit({
        type: "chat.tool_result", chat_id: "c1", run_id: "r1",
        tool_call_id: "tu_l1", output: "hi\n", is_error: false,
      });
    });
    await flush();
    expect(host.innerHTML).toContain('data-tool-state="done"');
    // Output landed into the assistant turn
    expect(host.textContent).toContain("hi");

    root.unmount();
  });

  test("unknown tool name falls back to GenericTool", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act as (cb: () => Promise<void> | void) => Promise<void>;
    const { FrameBus } = await import("../src/chat/bus");
    const { ChatRoot } = await import("../src/chat/ChatRoot");

    const bus = new FrameBus();
    const api = {
      createChat: async () => ({ id: "c1", title: "t", created_at: 0 }),
      postMessage: async () => ({ run_id: "r1", status: "running" }),
      listChats: async () => [],
      getMessages: async () => [],
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ChatRoot as any, { bus, api, chatId: "c1" }));
    });
    const flush = async () => {
      for (let i = 0; i < 25; i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      }
    };

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "c1", run_id: "r1", agent: "maya" });
      bus.emit({
        type: "chat.tool_use", chat_id: "c1", run_id: "r1",
        tool_call_id: "tu_e1", name: "Edit", input: { path: "x.ts", change: "..." },
      });
      bus.emit({
        type: "chat.tool_result", chat_id: "c1", run_id: "r1",
        tool_call_id: "tu_e1", output: "edited", is_error: false,
      });
    });
    await flush();

    expect(host.innerHTML).toContain('data-tool="Edit"');
    // After result lands, GenericTool auto-collapses (same as BashTool).
    // The state attribute proves the result was paired.
    expect(host.innerHTML).toContain('data-tool-state="done"');
    // Click the toggle button to expand and verify the output renders.
    const toggle = host.querySelector('[data-tool="Edit"] button') as HTMLButtonElement | null;
    expect(toggle).toBeTruthy();
    await act(async () => { toggle!.click(); });
    await flush();
    expect(host.textContent).toContain("edited");

    root.unmount();
  });
});
