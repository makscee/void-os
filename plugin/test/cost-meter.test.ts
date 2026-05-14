// CostMeter — static placeholder widget for the left sidebar.
// Renders fixed text until VOS-81 wires real numbers.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("CostMeter", () => {
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

  test("renders placeholder $0.00 / $5.00 daily text", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { CostMeter } = await import("../src/chat/CostMeter");

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CostMeter));
    });

    expect(host.textContent).toContain("$0.00 / $5.00");
    root.unmount();
  });
});
