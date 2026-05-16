// Unit tests for AskUserTool's internal render fn. We bypass assistant-ui's
// tool registry by going through `AskUserTool.__renderForTest`, which exposes
// the render component directly. Repo convention: happy-dom + react-dom/client
// (not @testing-library/react), matching ChatList.test.ts.

import { describe, it, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

function setupDom() {
  const win = new Window();
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  (globalThis as any).navigator = win.navigator;
  (globalThis as any).HTMLElement = win.HTMLElement;
  (globalThis as any).Element = win.Element;
  (globalThis as any).Node = win.Node;
  // happy-dom's querySelector throws via `new this.window.SyntaxError(...)`,
  // but the embedded Window does not expose SyntaxError. Patch it. Mirrors
  // the same workaround in chat-list.test.ts.
  (win as any).SyntaxError = SyntaxError;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

async function flush(act: any) {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
  }
}

function makeCtx(answerImpl?: (toolUseId: string, text: string) => Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409; error: string }>) {
  const calls: Array<{ toolUseId: string; text: string }> = [];
  const toasts: string[] = [];
  let answer409Calls = 0;
  const ctx = {
    chatId: "chat-1",
    answer: async (toolUseId: string, text: string) => {
      calls.push({ toolUseId, text });
      if (answerImpl) return answerImpl(toolUseId, text);
      return { ok: true } as const;
    },
    showToast: (t: string) => { toasts.push(t); },
    notifyAnswer409: () => { answer409Calls += 1; },
  };
  return { ctx, calls, toasts, get answer409Calls() { return answer409Calls; } };
}

describe("AskUserTool render", () => {
  beforeAll(() => {
    setupDom();
  });

  it("renders question + N option buttons when pending", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AskUserContext } = await import("../src/chat/AskUserContext");
    const { AskUserTool } = await import("../src/chat/tools/AskUserTool");
    const Render = (AskUserTool as any).__renderForTest;

    const { ctx } = makeCtx();
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          AskUserContext.Provider,
          { value: ctx },
          React.createElement(Render, {
            args: { question: "color?", options: ["red", "blue"] },
            isError: false,
            toolCallId: "tu-1",
            toolName: "ask_user",
          }),
        ),
      );
    });
    await flush(act);

    const prompt = host.querySelector('[data-testid="ask-user-prompt"]');
    expect(prompt).not.toBeNull();
    expect((host.textContent ?? "")).toContain("color?");
    const options = host.querySelectorAll('[data-testid="ask-user-option"]');
    expect(options.length).toBe(2);
    expect((options[0] as HTMLElement).getAttribute("data-value")).toBe("red");
    expect((options[1] as HTMLElement).getAttribute("data-value")).toBe("blue");

    await act(async () => { root.unmount(); });
  });

  it("renders question only when options absent", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AskUserContext } = await import("../src/chat/AskUserContext");
    const { AskUserTool } = await import("../src/chat/tools/AskUserTool");
    const Render = (AskUserTool as any).__renderForTest;

    const { ctx } = makeCtx();
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          AskUserContext.Provider,
          { value: ctx },
          React.createElement(Render, {
            args: { question: "your name?" },
            isError: false,
            toolCallId: "tu-2",
            toolName: "ask_user",
          }),
        ),
      );
    });
    await flush(act);

    expect(host.querySelector('[data-testid="ask-user-prompt"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="ask-user-option"]')).toBeNull();

    await act(async () => { root.unmount(); });
  });

  it("clicking option calls api.answer once, disables buttons", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AskUserContext } = await import("../src/chat/AskUserContext");
    const { AskUserTool } = await import("../src/chat/tools/AskUserTool");
    const Render = (AskUserTool as any).__renderForTest;

    const { ctx, calls } = makeCtx();
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          AskUserContext.Provider,
          { value: ctx },
          React.createElement(Render, {
            args: { question: "color?", options: ["red", "blue"] },
            isError: false,
            toolCallId: "tu-1",
            toolName: "ask_user",
          }),
        ),
      );
    });
    await flush(act);

    const red = host.querySelectorAll('[data-testid="ask-user-option"]')[0] as HTMLButtonElement;
    await act(async () => {
      red.click();
    });
    await flush(act);

    expect(calls).toEqual([{ toolUseId: "tu-1", text: "red" }]);
    const buttons = host.querySelectorAll('[data-testid="ask-user-option"]') as unknown as HTMLButtonElement[];
    for (const b of Array.from(buttons)) expect((b as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { root.unmount(); });
  });

  it("renders answered state when result is set", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AskUserContext } = await import("../src/chat/AskUserContext");
    const { AskUserTool } = await import("../src/chat/tools/AskUserTool");
    const Render = (AskUserTool as any).__renderForTest;

    const { ctx } = makeCtx();
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          AskUserContext.Provider,
          { value: ctx },
          React.createElement(Render, {
            args: { question: "color?", options: ["red", "blue"] },
            result: "red",
            isError: false,
            toolCallId: "tu-1",
            toolName: "ask_user",
          }),
        ),
      );
    });
    await flush(act);

    expect(host.querySelector('[data-testid="ask-user-option"]')).toBeNull();
    expect(host.textContent ?? "").toMatch(/answered:\s*red/i);

    await act(async () => { root.unmount(); });
  });

  it("409 from answer → notifyAnswer409 + toast", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AskUserContext } = await import("../src/chat/AskUserContext");
    const { AskUserTool } = await import("../src/chat/tools/AskUserTool");
    const Render = (AskUserTool as any).__renderForTest;

    const ctxBundle = makeCtx(async () => ({ ok: false as const, status: 409 as const, error: "already_resolved" }));
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          AskUserContext.Provider,
          { value: ctxBundle.ctx },
          React.createElement(Render, {
            args: { question: "color?", options: ["red", "blue"] },
            isError: false,
            toolCallId: "tu-1",
            toolName: "ask_user",
          }),
        ),
      );
    });
    await flush(act);

    const red = host.querySelector('[data-testid="ask-user-option"]') as HTMLButtonElement;
    await act(async () => { red.click(); });
    await flush(act);

    expect(ctxBundle.answer409Calls).toBe(1);
    expect(ctxBundle.toasts.length).toBeGreaterThan(0);
    expect(ctxBundle.toasts[0]).toMatch(/already resolved/i);

    await act(async () => { root.unmount(); });
  });

  it("network error re-enables buttons", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act;
    const { AskUserContext } = await import("../src/chat/AskUserContext");
    const { AskUserTool } = await import("../src/chat/tools/AskUserTool");
    const Render = (AskUserTool as any).__renderForTest;

    const { ctx, toasts } = makeCtx(async () => { throw new Error("net"); });
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          AskUserContext.Provider,
          { value: ctx },
          React.createElement(Render, {
            args: { question: "color?", options: ["red"] },
            isError: false,
            toolCallId: "tu-1",
            toolName: "ask_user",
          }),
        ),
      );
    });
    await flush(act);

    const red = host.querySelector('[data-testid="ask-user-option"]') as HTMLButtonElement;
    await act(async () => {
      red.click();
    });
    await flush(act);

    const redAfter = host.querySelector('[data-testid="ask-user-option"]') as HTMLButtonElement;
    expect(redAfter.disabled).toBe(false);
    expect(toasts.length).toBeGreaterThan(0);

    await act(async () => { root.unmount(); });
  });
});
