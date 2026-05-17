// CostMeter — daily token meter unit tests (VOS-110 T5).
// Verifies loading-state placeholder, fetched 4-token-split rendering, and
// error-state behaviour via a stubbed ChatApi.getCostToday().

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import type { ChatApi } from "../src/chat/api";

function makeStubApi(impl: Partial<ChatApi>): ChatApi {
  return impl as ChatApi;
}

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

  test("renders loading placeholder before fetch resolves and switches to ready with 4-token split", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { CostMeter } = await import("../src/chat/CostMeter");

    let resolveCost: (v: { total: { input_tokens: number; output_tokens: number; cache_create_tokens: number; cache_read_tokens: number } }) => void = () => {};
    const pending = new Promise<{ total: { input_tokens: number; output_tokens: number; cache_create_tokens: number; cache_read_tokens: number } }>((res) => {
      resolveCost = res;
    });
    const api = makeStubApi({
      getCostToday: () => pending,
    });

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CostMeter, { api }));
    });

    const meter = host.querySelector('[data-testid="cost-meter"]');
    expect(meter?.getAttribute("data-state")).toBe("loading");
    expect(meter?.textContent).toContain("— in / — out / — cc / — cr");

    await act(async () => {
      resolveCost({
        total: {
          input_tokens: 1234,
          output_tokens: 5678,
          cache_create_tokens: 1500000,
          cache_read_tokens: 2000,
        },
      });
      await pending;
    });

    expect(meter?.getAttribute("data-state")).toBe("ready");
    expect(meter?.textContent).toContain("1.2k in");
    expect(meter?.textContent).toContain("5.7k out");
    expect(meter?.textContent).toContain("1.5M cc");
    expect(meter?.textContent).toContain("2k cr");
    root.unmount();
  });

  test("switches to error state when getCostToday rejects", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { CostMeter } = await import("../src/chat/CostMeter");

    const rejected = Promise.reject(new Error("boom"));
    // Swallow the unhandled rejection on the original promise object.
    rejected.catch(() => {});
    const api = makeStubApi({
      getCostToday: () => rejected as unknown as ReturnType<ChatApi["getCostToday"]>,
    });

    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CostMeter, { api }));
      try { await rejected; } catch { /* expected */ }
    });

    const meter = host.querySelector('[data-testid="cost-meter"]');
    expect(meter?.getAttribute("data-state")).toBe("error");
    expect(meter?.textContent).toContain("— in / — out / — cc / — cr");
    root.unmount();
  });
});
