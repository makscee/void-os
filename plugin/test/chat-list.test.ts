// Component test for ChatList — render with a stub ChatApi, assert items
// land in the DOM, click triggers onSelect, "+ New" triggers onNewChat.

import { describe, test, expect, beforeAll, mock } from "bun:test";
import { Window } from "happy-dom";

// Mock obsidian before any ChatList import that transitively pulls formatRelativeTime.
// Include ItemView/WorkspaceLeaf stubs so chat-view.test.ts (which re-mocks) is unaffected
// when tests run in the same Bun process and the registry is shared.
mock.module("obsidian", () => ({
  moment: (_ts: number) => ({ fromNow: (_strip?: boolean) => "5 minutes" }),
  ItemView: class { containerEl: any = null; constructor(_leaf: unknown) {} },
  WorkspaceLeaf: class {},
}));

import type { ChatApi, ChatSummary } from "../src/chat/api";

// Fill the context-token fields ChatSummary requires; row fixtures below
// predate those fields and only set the columns the test exercises (VOS-167).
function fillSummary(p: Partial<ChatSummary>): ChatSummary {
  return {
    id: "c", agent: "maya", title: null, last_msg: null, updated_at: 0,
    last_run_status: null, cost_usd: 0, input_required: false,
    context_tokens: 0, context_input_tokens: 0, context_output_tokens: 0,
    context_cache_create_tokens: 0, context_cache_read_tokens: 0,
    ...p,
  };
}

function stubApi(chats: Array<Partial<ChatSummary>>): ChatApi {
  const filled = chats.map(fillSummary);
  return {
    async createChat() { return { id: "new", title: "untitled", created_at: 0 }; },
    async deleteChat() {},
    async postMessage() { return { run_id: "r", status: "running" }; },
    async cancel() { return { run_id: "r", status: "cancelled" }; },
    async answer() { return { ok: true as const }; },
    async listChats() { return filled; },
    async getMessages() { return []; },
    async getCostToday() { return { total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 } }; },
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
    // resolveStatus maps last_run_status:"done" → "idle" (no input_required).
    const statuses = Array.from(host.querySelectorAll("[data-status]"))
      .map((el: any) => el.getAttribute("data-status"));
    expect(statuses).toContain("idle");
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
      async deleteChat() {},
      async postMessage() { return { run_id: "r", status: "running" }; },
      async cancel() { return { run_id: "r", status: "cancelled" }; },
      async answer() { return { ok: true as const }; },
      async listChats() {
        calls++;
        return [fillSummary({
          id: "c1",
          agent: "maya",
          title: "T",
          last_msg: "hello",
          updated_at: 1,
          last_run_status: calls === 1 ? "running" : "cancelled",
          cost_usd: 0,
          input_required: false,
        })];
      },
      async getMessages() { return []; },
      async getCostToday() { return { total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 } }; },
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
      async deleteChat() {},
      async postMessage() { return { run_id: "r", status: "running" }; },
      async cancel() { return { run_id: "r", status: "cancelled" }; },
      async answer() { return { ok: true as const }; },
      async listChats() {
        calls++;
        return [fillSummary({ id: `c${calls}`, agent: "maya", title: `t${calls}`, last_msg: null, updated_at: calls, last_run_status: null, cost_usd: 0, input_required: false })];
      },
      async getMessages() { return []; },
      async getCostToday() { return { total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 } }; },
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

  test("renders unified status dot with data-status precedence", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { ChatList } = await import("../src/chat/ChatList");

    const chats: ChatSummary[] = [
      // input_required wins even if last_run_status="running".
      { id: "c1", agent: "maya", title: "needs input", last_msg: null, updated_at: 2, last_run_status: "running", cost_usd: 0, input_required: true,
        context_input_tokens: 0, context_output_tokens: 0, context_cache_create_tokens: 0, context_cache_read_tokens: 0, context_tokens: 0 },
      // plain idle row.
      { id: "c2", agent: "maya", title: "calm", last_msg: null, updated_at: 1, last_run_status: "done", cost_usd: 0, input_required: false,
        context_input_tokens: 0, context_output_tokens: 0, context_cache_create_tokens: 0, context_cache_read_tokens: 0, context_tokens: 0 },
      // error wins over no input_required.
      { id: "c3", agent: "maya", title: "broken", last_msg: null, updated_at: 0, last_run_status: "error", cost_usd: 0, input_required: false,
        context_input_tokens: 0, context_output_tokens: 0, context_cache_create_tokens: 0, context_cache_read_tokens: 0, context_tokens: 0 },
    ];

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ChatList, {
        api: stubApi(chats), activeChatId: null, onSelect: (_id: string, _agent: string) => {}, onNewChat: () => {}, refreshKey: 1,
      }));
    });
    await flush(act);

    const statusOf = (id: string) => (host.querySelector(
      `[data-testid='chat-row'][data-chat-id='${id}'] [data-testid='chat-row-status']`,
    ) as HTMLElement).dataset.status;

    expect(statusOf("c1")).toBe("input_required");
    expect(statusOf("c2")).toBe("idle");
    expect(statusOf("c3")).toBe("error");

    root.unmount();
  });

  test("renders context cell with formatted tokens per row", async () => {
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

    const cellC1 = cell("c1");
    expect(cellC1!.hasAttribute("title")).toBe(false);

    root.unmount();
  });

  test("renders agent badge and relative timestamp per row", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { ChatList } = await import("../src/chat/ChatList");

    const chats: ChatSummary[] = [
      { id: "c1", agent: "deep", title: "research thread", last_msg: null, updated_at: Date.now() - 300_000, last_run_status: "done", cost_usd: 0, input_required: false,
        context_input_tokens: 0, context_output_tokens: 0, context_cache_create_tokens: 0, context_cache_read_tokens: 0, context_tokens: 0 },
    ];

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ChatList, {
        api: stubApi(chats), activeChatId: null, onSelect: (_id: string, _agent: string) => {}, onNewChat: () => {}, refreshKey: 1,
      }));
    });
    await flush(act);

    const row = host.querySelector(`[data-testid='chat-row'][data-chat-id='c1']`);
    const badge = row!.querySelector("[data-testid='chat-row-agent']") as HTMLElement;
    const time  = row!.querySelector("[data-testid='chat-row-time']") as HTMLElement;
    expect(badge.textContent).toBe("deep");
    expect(time.textContent).toBe("5 minutes"); // from mocked moment

    root.unmount();
  });
});
