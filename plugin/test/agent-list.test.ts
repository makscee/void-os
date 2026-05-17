// VOS-113 T2: AgentList component — render rows, active marker, click,
// empty + error states, alphabetical sort.
//
// Test harness mirrors plugin/test/chat-list.test.ts (happy-dom + React
// act + flush loop). No new helpers — siblings inline this pattern.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import type { AgentsApi } from "../src/agents/api";
import type { AgentListEntry } from "../src/agents/types";

function stubAgentsApi(items: AgentListEntry[] | (() => Promise<AgentListEntry[]>)): Pick<AgentsApi, "listAgents"> {
  return {
    async listAgents() {
      return typeof items === "function" ? items() : items;
    },
  };
}

describe("AgentList", () => {
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

  test("renders one row per agent, sorted alphabetically (case-insensitive)", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AgentList } = await import("../src/chat/AgentList");

    const api = stubAgentsApi([
      { name: "Zed", description: "z" },
      { name: "alpha", description: "a" },
      { name: "Maya", description: "m" },
    ]);
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(AgentList, {
        agentsApi: api, activeAgent: null, onPickAgent: () => {},
      }));
    });
    await flush(act);

    const rows = host.querySelectorAll("[data-testid='agent-row']");
    expect(rows.length).toBe(3);
    const names = Array.from(rows).map((r: any) => r.getAttribute("data-agent-name"));
    expect(names).toEqual(["alpha", "Maya", "Zed"]);
    root.unmount();
  });

  test("active agent row has data-active=\"true\" and bold class; others false", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AgentList } = await import("../src/chat/AgentList");

    const api = stubAgentsApi([
      { name: "maya", description: "m" },
      { name: "sage", description: "s" },
    ]);
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(AgentList, {
        agentsApi: api, activeAgent: "maya", onPickAgent: () => {},
      }));
    });
    await flush(act);

    const mayaRow = host.querySelector("[data-agent-name='maya']") as any;
    const sageRow = host.querySelector("[data-agent-name='sage']") as any;
    expect(mayaRow.getAttribute("data-active")).toBe("true");
    expect(sageRow.getAttribute("data-active")).toBe("false");
    // Bold class on active label span.
    const mayaLabel = mayaRow.querySelector("[data-testid='agent-name']");
    expect(mayaLabel.className).toContain("vos:font-semibold");
    root.unmount();
  });

  test("clicking a row calls onPickAgent with that row's name", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AgentList } = await import("../src/chat/AgentList");

    const api = stubAgentsApi([
      { name: "maya", description: "m" },
      { name: "sage", description: "s" },
    ]);
    const picks: string[] = [];
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(AgentList, {
        agentsApi: api, activeAgent: null, onPickAgent: (n: string) => { picks.push(n); },
      }));
    });
    await flush(act);

    const sageRow = host.querySelector("[data-agent-name='sage']") as any;
    await act(async () => { sageRow.click(); });
    expect(picks).toEqual(["sage"]);
    root.unmount();
  });

  test("empty list renders the empty notice and no rows", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AgentList } = await import("../src/chat/AgentList");

    const api = stubAgentsApi([]);
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(AgentList, {
        agentsApi: api, activeAgent: null, onPickAgent: () => {},
      }));
    });
    await flush(act);

    const rows = host.querySelectorAll("[data-testid='agent-row']");
    expect(rows.length).toBe(0);
    expect(host.textContent).toContain("No agents in vault/agents/");
    root.unmount();
  });

  test("listAgents rejection renders error string", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AgentList } = await import("../src/chat/AgentList");

    const api = stubAgentsApi(async () => { throw new Error("boom"); });
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(AgentList, {
        agentsApi: api, activeAgent: null, onPickAgent: () => {},
      }));
    });
    await flush(act);

    expect(host.textContent).toContain("daemon offline");
    const rows = host.querySelectorAll("[data-testid='agent-row']");
    expect(rows.length).toBe(0);
    root.unmount();
  });

  test("refreshKey change re-fetches agents", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AgentList } = await import("../src/chat/AgentList");

    let calls = 0;
    const api: Pick<AgentsApi, "listAgents"> = {
      async listAgents() {
        calls++;
        return calls === 1
          ? [{ name: "maya", description: "" }]
          : [{ name: "maya", description: "" }, { name: "sage", description: "" }];
      },
    };
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(AgentList, {
        agentsApi: api, activeAgent: null, onPickAgent: () => {}, refreshKey: 0,
      }));
    });
    await flush(act);
    expect(host.querySelectorAll("[data-testid='agent-row']").length).toBe(1);

    await act(async () => {
      root.render(React.createElement(AgentList, {
        agentsApi: api, activeAgent: null, onPickAgent: () => {}, refreshKey: 1,
      }));
    });
    await flush(act);
    expect(host.querySelectorAll("[data-testid='agent-row']").length).toBe(2);
    expect(calls).toBe(2);
    root.unmount();
  });
});
