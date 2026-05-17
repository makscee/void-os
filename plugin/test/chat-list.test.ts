// Component test for ChatList — render with a stub ChatApi, assert items
// land in the DOM, click triggers onSelect, "+ New" triggers onNewChat.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

import type { ChatApi, ChatSummary } from "../src/chat/api";

function stubApi(chats: ChatSummary[]): ChatApi {
  return {
    async createChat() { return { id: "new", title: "untitled", created_at: 0 }; },
    async postMessage() { return { run_id: "r", status: "running" }; },
    async cancel() { return { run_id: "r", status: "cancelled" }; },
    async listChats() { return chats; },
    async getMessages() { return []; },
  };
}

describe("ChatList", () => {
  beforeAll(() => {
    const win = new Window();
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
    (win as any).SyntaxError = SyntaxError;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  const flush = async (act: any) => {
    for (let i = 0; i < 10; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
  };

  test("renders chat rows and falls back to last_msg when title is null", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ChatList } = await import("../src/chat/ChatList");

    const api = stubApi([
      { id: "c1", agent: "maya", title: null, last_msg: "first chat preview", updated_at: 2, last_run_status: "done", cost_usd: 0, input_required: false },
      { id: "c2", agent: "maya", title: "Has Title", last_msg: "ignored", updated_at: 1, last_run_status: "running", cost_usd: 0, input_required: false },
    ]);

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ChatList, {
          api,
          activeChatId: null,
          onSelect: (_id: string, _agent: string) => {},
          onNewChat: () => {},
        }),
      );
    });
    await flush(act);

    const rows = host.querySelectorAll("[data-testid='chat-row']");
    expect(rows.length).toBe(2);
    expect(host.textContent).toContain("first chat preview");
    expect(host.textContent).toContain("Has Title");
    // Status badges are rendered with data-status attribute.
    const statuses = Array.from(host.querySelectorAll("[data-status]"))
      .map((el: any) => el.getAttribute("data-status"));
    expect(statuses).toContain("done");
    expect(statuses).toContain("running");

    root.unmount();
  });

  test("clicking a row calls onSelect with chat id", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ChatList } = await import("../src/chat/ChatList");

    const api = stubApi([
      { id: "c1", agent: "maya", title: "A", last_msg: null, updated_at: 1, last_run_status: null, cost_usd: 0, input_required: false },
      { id: "c2", agent: "maya", title: "B", last_msg: null, updated_at: 0, last_run_status: null, cost_usd: 0, input_required: false },
    ]);
    const selected: Array<{ id: string; agent: string }> = [];

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ChatList, {
          api,
          activeChatId: null,
          onSelect: (id: string, agent: string) => selected.push({ id, agent }),
          onNewChat: () => {},
        }),
      );
    });
    await flush(act);

    const rows = host.querySelectorAll("[data-testid='chat-row']");
    await act(async () => { (rows[1] as any).click(); });
    expect(selected).toEqual([{ id: "c2", agent: "maya" }]);

    root.unmount();
  });

  test("clicking + New triggers onNewChat", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ChatList } = await import("../src/chat/ChatList");

    const api = stubApi([]);
    let clicked = 0;

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ChatList, {
          api,
          activeChatId: null,
          onSelect: (_id: string, _agent: string) => {},
          onNewChat: () => { clicked++; },
        }),
      );
    });
    await flush(act);

    const btn = host.querySelector("[data-testid='new-chat-btn']") as any;
    await act(async () => { btn.click(); });
    expect(clicked).toBe(1);

    root.unmount();
  });

  test("polls listChats while any row is running, stops when none are", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ChatList } = await import("../src/chat/ChatList");

    // First fetch returns a running row; subsequent fetches return cancelled.
    // The poll should re-fetch and replace state with the cancelled snapshot.
    let calls = 0;
    const api: ChatApi = {
      async createChat() { return { id: "x", title: "t", created_at: 0 }; },
      async postMessage() { return { run_id: "r", status: "running" }; },
      async cancel() { return { run_id: "r", status: "cancelled" }; },
      async listChats() {
        calls++;
        return [{
          id: "c1",
          agent: "maya",
          title: "T",
          last_msg: "hello",
          updated_at: 1,
          last_run_status: calls === 1 ? "running" : "cancelled",
          cost_usd: 0,
          input_required: false,
        }];
      },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatList, {
        api, activeChatId: null, onSelect: (_id: string, _agent: string) => {}, onNewChat: () => {},
      }));
    });
    await flush(act);
    expect(calls).toBe(1);
    // First render: dot status is running.
    let dot = host.querySelector("[data-status]");
    expect(dot?.getAttribute("data-status")).toBe("running");

    // Advance ~POLL_MS by sleeping in real time. Test file is already
    // tolerant of small timing variance via the flush loop.
    await act(async () => { await new Promise((r) => setTimeout(r, 3200)); });
    await flush(act);

    // Poll fired at least once; status flipped to cancelled.
    expect(calls).toBeGreaterThanOrEqual(2);
    dot = host.querySelector("[data-status]");
    expect(dot?.getAttribute("data-status")).toBe("cancelled");

    // Poll should now stop since no row is running. Snapshot calls and wait
    // another interval — count must not grow.
    const callsAfterStop = calls;
    await act(async () => { await new Promise((r) => setTimeout(r, 3200)); });
    await flush(act);
    expect(calls).toBe(callsAfterStop);

    root.unmount();
  }, 15000);

  test("re-fetches when refreshKey changes", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ChatList } = await import("../src/chat/ChatList");

    let calls = 0;
    const api: ChatApi = {
      async createChat() { return { id: "x", title: "t", created_at: 0 }; },
      async postMessage() { return { run_id: "r", status: "running" }; },
    async cancel() { return { run_id: "r", status: "cancelled" }; },
      async listChats() {
        calls++;
        return [{ id: `c${calls}`, agent: "maya", title: `t${calls}`, last_msg: null, updated_at: calls, last_run_status: null, cost_usd: 0, input_required: false }];
      },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatList, {
        api, activeChatId: null, onSelect: (_id: string, _agent: string) => {}, onNewChat: () => {}, refreshKey: 0,
      }));
    });
    await flush(act);
    expect(calls).toBe(1);

    await act(async () => {
      root.render(React.createElement(ChatList, {
        api, activeChatId: null, onSelect: (_id: string, _agent: string) => {}, onNewChat: () => {}, refreshKey: 1,
      }));
    });
    await flush(act);
    expect(calls).toBe(2);

    root.unmount();
  });

  test("renders input-required dot when chat.input_required is true", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ChatList } = await import("../src/chat/ChatList");

    const api = stubApi([
      { id: "c1", agent: "maya", title: "needs input", last_msg: null, updated_at: 2, last_run_status: "done", cost_usd: 0, input_required: true },
      { id: "c2", agent: "maya", title: "calm",        last_msg: null, updated_at: 1, last_run_status: "done", cost_usd: 0, input_required: false },
    ]);

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ChatList, {
          api, activeChatId: null, onSelect: (_id: string, _agent: string) => {}, onNewChat: () => {},
        }),
      );
    });
    await flush(act);

    const rowC1 = host.querySelector(`[data-testid='chat-row'][data-chat-id='c1']`);
    const rowC2 = host.querySelector(`[data-testid='chat-row'][data-chat-id='c2']`);
    const dotC1 = rowC1!.querySelector("[data-testid='input-required-dot']") as any;
    const dotC2 = rowC2!.querySelector("[data-testid='input-required-dot']") as any;
    // c1 shows the dot: element present, NOT marked invisible.
    expect(dotC1).toBeTruthy();
    expect(dotC1.className).not.toContain("vos:invisible");
    // c2 preserves alignment via vos:invisible slot — element exists but is invisible.
    expect(dotC2).toBeTruthy();
    expect(dotC2.className).toContain("vos:invisible");

    root.unmount();
  });

  test("renders context cell with formatted tokens + tooltip per row", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ChatList } = await import("../src/chat/ChatList");

    const api = stubApi([
      { id: "c1", agent: "maya", title: "big",   last_msg: null, updated_at: 3, last_run_status: "done", cost_usd: 0, input_required: false,
        context_tokens: 12345, context_input_tokens: 1000, context_output_tokens: 2000, context_cache_create_tokens: 3000, context_cache_read_tokens: 6345 },
      { id: "c2", agent: "maya", title: "small", last_msg: null, updated_at: 2, last_run_status: "done", cost_usd: 0, input_required: false,
        context_tokens: 420,   context_input_tokens: 100,  context_output_tokens: 200,  context_cache_create_tokens: 50,   context_cache_read_tokens: 70 },
      { id: "c3", agent: "maya", title: "empty", last_msg: null, updated_at: 1, last_run_status: "done", cost_usd: 0, input_required: false,
        context_tokens: null,  context_input_tokens: null, context_output_tokens: null, context_cache_create_tokens: null, context_cache_read_tokens: null },
    ]);

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ChatList, {
          api, activeChatId: null, onSelect: (_id: string, _agent: string) => {}, onNewChat: () => {},
        }),
      );
    });
    await flush(act);

    const cell = (id: string) =>
      host.querySelector(`[data-testid='chat-row'][data-chat-id='${id}'] [data-testid='context-cell']`) as HTMLElement | null;

    expect(cell("c1")?.textContent).toBe("12.3k");
    expect(cell("c2")?.textContent).toBe("420");
    expect(cell("c3")?.textContent).toBe("—");

    expect(cell("c1")?.getAttribute("title")).toBe("1k in / 2k out / 3k cc / 6.3k cr");
    expect(cell("c2")?.getAttribute("title")).toBe("100 in / 200 out / 50 cc / 70 cr");
    expect(cell("c3")?.getAttribute("title")).toBe("");

    root.unmount();
  });
});
