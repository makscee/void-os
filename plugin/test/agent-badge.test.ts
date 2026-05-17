import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

beforeAll(() => {
  const win = new Window();
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  (globalThis as any).HTMLElement = win.HTMLElement;
  (globalThis as any).Element = win.Element;
  (globalThis as any).Node = win.Node;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // happy-dom SyntaxError fix: attribute selectors use new this.window.SyntaxError
  (win as any).SyntaxError = SyntaxError;
  const origQSA = (win.document as any).querySelectorAll.bind(win.document);
  (win.document as any).querySelectorAll = (sel: string) => {
    try { return origQSA(sel); } catch { return [] as any; }
  };
});

import { AgentBadge } from "../src/chat/AgentBadge";

const flush = async (act: any) => {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
};

describe("<AgentBadge />", () => {
  test("renders the agent name in a labeled pill", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(AgentBadge, { agent: "maya" }));
    });
    await flush(act);
    const pill = host.querySelector("[data-testid='chat-row-agent']") as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toBe("maya");
  });

  test("renders empty string agent as empty pill (no crash)", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(AgentBadge, { agent: "" }));
    });
    await flush(act);
    const pill = host.querySelector("[data-testid='chat-row-agent']") as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toBe("");
  });
});
