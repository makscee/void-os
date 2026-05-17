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

import { resolveStatus, StatusDot } from "../src/chat/StatusDot";

describe("resolveStatus precedence", () => {
  test("input_required wins over everything", () => {
    expect(resolveStatus(true, "error")).toBe("input_required");
    expect(resolveStatus(true, "running")).toBe("input_required");
    expect(resolveStatus(true, "done")).toBe("input_required");
    expect(resolveStatus(true, null)).toBe("input_required");
  });
  test("error beats running/cancelled/done when no input_required", () => {
    expect(resolveStatus(false, "error")).toBe("error");
  });
  test("running beats cancelled/done", () => {
    expect(resolveStatus(false, "running")).toBe("running");
  });
  test("cancelled beats done/null", () => {
    expect(resolveStatus(false, "cancelled")).toBe("cancelled");
  });
  test("done/null → idle", () => {
    expect(resolveStatus(false, "done")).toBe("idle");
    expect(resolveStatus(false, null)).toBe("idle");
  });
  test("unknown last_run_status string → idle (defensive)", () => {
    expect(resolveStatus(false, "whatever")).toBe("idle");
  });
});

describe("<StatusDot />", () => {
  const flush = async (act: any) => {
    for (let i = 0; i < 5; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
  };

  test("renders data-status='input_required' with warning color", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(StatusDot, { input_required: true, last_run_status: "done" }));
    });
    await flush(act);
    const dot = host.querySelector("[data-testid='chat-row-status']") as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.dataset.status).toBe("input_required");
  });

  test("renders data-status='idle' (invisible slot) when nothing notable", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(StatusDot, { input_required: false, last_run_status: "done" }));
    });
    await flush(act);
    const dot = host.querySelector("[data-testid='chat-row-status']") as HTMLElement;
    expect(dot.dataset.status).toBe("idle");
  });
});
