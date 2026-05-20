// VOS-172: tests for the global activity list — normalizeTasks (api shim)
// + the ActivityList component (render / sort / click).

import { describe, test, expect, beforeAll, mock } from "bun:test";
import { Window } from "happy-dom";

// Mock obsidian before any ActivityList import that transitively pulls
// formatRelativeTime / AgentBadge.
mock.module("obsidian", () => ({
  moment: (_ts: number) => ({ fromNow: (_strip?: boolean) => "5 minutes" }),
  ItemView: class { containerEl: any = null; constructor(_leaf: unknown) {} },
  WorkspaceLeaf: class {},
}));

import { normalizeTasks } from "../src/chat/api";
import type { ChatApi, TaskActivityItem } from "../src/chat/api";

function fillTask(p: Partial<TaskActivityItem>): TaskActivityItem {
  return {
    id: "t",
    context_id: "c",
    context_title: null,
    parent_task_id: null,
    agent: "maya",
    state: "TASK_STATE_WORKING",
    last_event: 0,
    created_at: 0,
    updated_at: 0,
    last_msg: null,
    ...p,
  };
}

function stubApi(tasks: TaskActivityItem[]): ChatApi {
  return {
    async createChat() { return { id: "new", title: "untitled", created_at: 0 }; },
    async deleteChat() {},
    async postMessage() { return { run_id: "r", status: "running" }; },
    async cancel() { return { run_id: "r", status: "cancelled" }; },
    async answer() { return { ok: true as const }; },
    async listChats() { return []; },
    async listTasks() { return tasks; },
    async getMessages() { return []; },
    async getCostToday() {
      return { total: { input_tokens: 0, output_tokens: 0, cache_create_tokens: 0, cache_read_tokens: 0 } };
    },
  };
}

describe("normalizeTasks", () => {
  test("normalizes well-formed rows", () => {
    const rows = normalizeTasks([
      {
        id: "t1",
        context_id: "c1",
        context_title: "Ctx",
        parent_task_id: null,
        agent: "maya",
        state: "TASK_STATE_WORKING",
        last_event: 1234,
        created_at: 1,
        updated_at: 2,
        last_msg: "hello",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "t1",
      context_id: "c1",
      state: "TASK_STATE_WORKING",
      last_event: 1234,
      last_msg: "hello",
    });
  });

  test("skips rows missing required string keys", () => {
    expect(normalizeTasks([{ context_id: "c", state: "X" }])).toHaveLength(0);
    expect(normalizeTasks([{ id: "t", state: "X" }])).toHaveLength(0);
    expect(normalizeTasks([{ id: "t", context_id: "c" }])).toHaveLength(0);
    expect(normalizeTasks("not-an-array")).toHaveLength(0);
  });

  test("coerces optional fields to typed null", () => {
    const rows = normalizeTasks([
      { id: "t", context_id: "c", state: "TASK_STATE_WORKING" },
    ]);
    expect(rows[0]!.context_title).toBeNull();
    expect(rows[0]!.agent).toBeNull();
    expect(rows[0]!.last_event).toBeNull();
    expect(rows[0]!.last_msg).toBeNull();
  });
});

describe("ActivityList", () => {
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

  async function flush(act: any) {
    for (let i = 0; i < 5; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
  }

  test("renders one row per Task, daemon order preserved", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ActivityList } = await import("../src/chat/ActivityList");

    const api = stubApi([
      fillTask({ id: "t1", last_event: 3000, last_msg: "newest", state: "TASK_STATE_WORKING" }),
      fillTask({ id: "t2", last_event: 2000, last_msg: "middle", state: "TASK_STATE_COMPLETED" }),
      fillTask({ id: "t3", last_event: 1000, last_msg: "oldest", state: "TASK_STATE_INPUT_REQUIRED" }),
    ]);

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ActivityList, {
        api, activeTaskId: null, onOpenTask: () => {},
      }));
    });
    await flush(act);

    const rows = host.querySelectorAll(".void-os-activity-row");
    expect(rows.length).toBe(3);
    // Daemon returns activity-DESC; the list preserves that order.
    expect(rows[0].getAttribute("data-task-id")).toBe("t1");
    expect(rows[2].getAttribute("data-task-id")).toBe("t3");
    // One-line preview surfaces the message.
    const line = host.querySelector("[data-testid='activity-row-line']");
    expect(line?.textContent).toBe("newest");

    root.unmount();
  }, 15000);

  test("clicking a row calls onOpenTask with the Task item", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ActivityList } = await import("../src/chat/ActivityList");

    const api = stubApi([
      fillTask({ id: "t9", context_id: "ctx-9", last_event: 1, state: "TASK_STATE_COMPLETED" }),
    ]);
    let opened: TaskActivityItem | null = null;

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ActivityList, {
        api,
        activeTaskId: null,
        onOpenTask: (it: TaskActivityItem) => { opened = it; },
      }));
    });
    await flush(act);

    const row = host.querySelector("[data-testid='activity-row-t9']") as HTMLElement;
    expect(row).toBeTruthy();
    await act(async () => { row.click(); });

    expect(opened).not.toBeNull();
    expect(opened!.id).toBe("t9");
    expect(opened!.context_id).toBe("ctx-9");

    root.unmount();
  }, 15000);

  test("shows the empty state when there are no Tasks", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { ActivityList } = await import("../src/chat/ActivityList");

    const api = stubApi([]);
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ActivityList, {
        api, activeTaskId: null, onOpenTask: () => {},
      }));
    });
    await flush(act);

    expect(host.querySelector("[data-testid='activity-list-empty']")).toBeTruthy();
    root.unmount();
  }, 15000);
});
