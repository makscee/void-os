// VOS-160: InspectorRoot component — empty state, agent rows, click-to-
// expand trace, auto-refresh poll, offline-keeps-last-snapshot.
//
// Harness mirrors agent-list.test.tsx (happy-dom + React act + flush
// loop). No new helpers — siblings inline this pattern.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import type { InflightApi } from "../src/agents/inflight-api";
import type { AgentEvent, InflightAgent } from "../src/agents/inflight-types";

function agent(over: Partial<InflightAgent> = {}): InflightAgent {
  return {
    agent_id: "t1",
    parent_id: null,
    task_id: "VOS-1",
    started_at: new Date().toISOString(),
    current_phase: "tool_call",
    last_action: "tool_call Bash",
    last_summary: "tool_call Bash",
    last_ts: new Date().toISOString(),
    trace: [],
    ended: false,
    ended_at_ms: null,
    control_state: null,
    ...over,
  };
}

function ev(over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    ts: new Date().toISOString(),
    agent_id: "t1",
    parent_id: null,
    kind: "tool_call",
    summary: "tool_call Bash",
    ...over,
  };
}

/** InflightApi stub. `frames` is consumed one snapshot per poll; the last
 *  frame repeats once exhausted. A frame of `null` throws (offline). */
function stubApi(frames: Array<InflightAgent[] | null>): InflightApi {
  let i = 0;
  return {
    async getInflight() {
      const frame = frames[Math.min(i, frames.length - 1)];
      i++;
      if (frame === null) throw new Error("offline");
      return frame;
    },
    async postVerb(agentId) {
      return { agent_id: agentId, control_state: "running" as const };
    },
    async postBranch(agentId) {
      return {
        agent_id: agentId,
        worktree_path: `/tmp/wt/${agentId}`,
        branch: `branch/${agentId}`,
        base_sha: "0".repeat(40),
      };
    },
  };
}

describe("InspectorRoot", () => {
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
    for (let i = 0; i < 12; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 6)); });
    }
  };

  test("renders the empty state when no agents are in flight", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { InspectorRoot } = await import("../src/agents/InspectorRoot");

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(InspectorRoot, { inflightApi: stubApi([[]]), pollMs: 5 }));
    });
    await flush(act);

    expect(host.querySelector("[data-testid='inspector-empty']")).not.toBeNull();
    expect(host.querySelectorAll("[data-testid='inspector-agent-row']").length).toBe(0);
    root.unmount();
  });

  test("renders one row per in-flight agent", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { InspectorRoot } = await import("../src/agents/InspectorRoot");

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(InspectorRoot, {
        inflightApi: stubApi([[agent({ agent_id: "a" }), agent({ agent_id: "b" })]]),
        pollMs: 5,
      }));
    });
    await flush(act);

    expect(host.querySelectorAll("[data-testid='inspector-agent-row']").length).toBe(2);
    expect(host.querySelector("[data-testid='inspector-empty']")).toBeNull();
    root.unmount();
  });

  test("clicking a row expands its step-by-step trace", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { InspectorRoot } = await import("../src/agents/InspectorRoot");

    const rows = [agent({
      agent_id: "a",
      trace: [ev({ kind: "spawn", summary: "spawn impl" }), ev({ kind: "tool_call", summary: "tool_call Bash" })],
    })];
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(InspectorRoot, { inflightApi: stubApi([rows]), pollMs: 5 }));
    });
    await flush(act);

    // Trace collapsed until clicked.
    expect(host.querySelector("[data-testid='inspector-trace']")).toBeNull();

    const rowEl = host.querySelector("[data-testid='inspector-agent-row']") as HTMLElement;
    await act(async () => { rowEl.click(); });

    const trace = host.querySelector("[data-testid='inspector-trace']");
    expect(trace).not.toBeNull();
    expect(host.querySelectorAll("[data-testid='inspector-trace-event']").length).toBe(2);
    expect(rowEl.getAttribute("data-expanded")).toBe("true");

    // Second click collapses.
    await act(async () => { rowEl.click(); });
    expect(host.querySelector("[data-testid='inspector-trace']")).toBeNull();
    root.unmount();
  });

  test("auto-refresh poll picks up a newly-appeared agent without reload", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { InspectorRoot } = await import("../src/agents/InspectorRoot");

    // First poll: empty. Subsequent polls: one agent.
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(InspectorRoot, {
        inflightApi: stubApi([[], [agent({ agent_id: "late" })]]),
        pollMs: 5,
      }));
    });
    await flush(act);

    expect(host.querySelectorAll("[data-testid='inspector-agent-row']").length).toBe(1);
    root.unmount();
  });

  test("offline error keeps the last good snapshot and shows the offline banner", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { InspectorRoot } = await import("../src/agents/InspectorRoot");

    // First poll: one agent. Then the daemon goes offline.
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(InspectorRoot, {
        inflightApi: stubApi([[agent({ agent_id: "x" })], null]),
        pollMs: 5,
      }));
    });
    await flush(act);

    // The row stays on screen; the offline banner appears.
    expect(host.querySelectorAll("[data-testid='inspector-agent-row']").length).toBe(1);
    expect(host.querySelector("[data-testid='inspector-offline']")).not.toBeNull();
    root.unmount();
  });
});
