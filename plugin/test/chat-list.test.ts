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
      { id: "c1", agent: "maya", title: null, last_msg: "first chat preview", updated_at: 2, last_run_status: "done" },
      { id: "c2", agent: "maya", title: "Has Title", last_msg: "ignored", updated_at: 1, last_run_status: "running" },
    ]);

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ChatList, {
          api,
          activeChatId: null,
          onSelect: () => {},
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
      { id: "c1", agent: "maya", title: "A", last_msg: null, updated_at: 1, last_run_status: null },
      { id: "c2", agent: "maya", title: "B", last_msg: null, updated_at: 0, last_run_status: null },
    ]);
    const selected: string[] = [];

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ChatList, {
          api,
          activeChatId: null,
          onSelect: (id: string) => selected.push(id),
          onNewChat: () => {},
        }),
      );
    });
    await flush(act);

    const rows = host.querySelectorAll("[data-testid='chat-row']");
    await act(async () => { (rows[1] as any).click(); });
    expect(selected).toEqual(["c2"]);

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
          onSelect: () => {},
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
        }];
      },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatList, {
        api, activeChatId: null, onSelect: () => {}, onNewChat: () => {},
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
        return [{ id: `c${calls}`, agent: "maya", title: `t${calls}`, last_msg: null, updated_at: calls, last_run_status: null }];
      },
      async getMessages() { return []; },
    };

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ChatList, {
        api, activeChatId: null, onSelect: () => {}, onNewChat: () => {}, refreshKey: 0,
      }));
    });
    await flush(act);
    expect(calls).toBe(1);

    await act(async () => {
      root.render(React.createElement(ChatList, {
        api, activeChatId: null, onSelect: () => {}, onNewChat: () => {}, refreshKey: 1,
      }));
    });
    await flush(act);
    expect(calls).toBe(2);

    root.unmount();
  });
});
