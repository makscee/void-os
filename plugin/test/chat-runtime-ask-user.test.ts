// Runtime ask_user routing (VOS-90 T5):
//   - send() routes to api.answer when pendingAskUser has no options
//     (free-form mode);
//   - send() is inert + toast when pendingAskUser has options
//     (buttons-only — Send hidden but Enter can still fire);
//   - send() falls through to postMessage when no pendingAskUser.
//
// Uses the same happy-dom + React.createRoot + act() harness as the other
// runtime tests (no @testing-library/react dependency). The hook's handle
// is exposed through a ref so the test can drive .send() directly.

import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

describe("runtime ask_user routing (VOS-90 T5)", () => {
  beforeAll(() => {
    const win = new Window();
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
    (globalThis as any).ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
    (globalThis as any).MutationObserver = (globalThis as any).MutationObserver
      ?? class { observe(){} disconnect(){} takeRecords(){ return []; } };
    (win as any).SyntaxError = SyntaxError;
    const origDocQSA = (win.document as any).querySelectorAll.bind(win.document);
    (win.document as any).querySelectorAll = (sel: string) => {
      try { return origDocQSA(sel); } catch { return [] as any; }
    };
    (globalThis as any).requestAnimationFrame =
      (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0) as any;
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  type SpyCall =
    | { kind: "post"; cid: string; text: string }
    | { kind: "answer"; cid: string; toolUseId: string; text: string };

  function makeApi(calls: SpyCall[]) {
    return {
      createChat: async () => ({ id: "chat-1", title: "", created_at: 0 }),
      postMessage: async (cid: string, text: string) => {
        calls.push({ kind: "post", cid, text });
        return { run_id: "r1", status: "running" };
      },
      answer: async (cid: string, toolUseId: string, text: string) => {
        calls.push({ kind: "answer", cid, toolUseId, text });
        return { ok: true } as const;
      },
      cancel: async () => ({ noActiveRun: true } as const),
      listChats: async () => [],
      getMessages: async () => [],
    };
  }

  type Handle = {
    send: (text: string) => Promise<void>;
    pendingAskUser: unknown;
  };

  /** Mount the hook in a harness component and capture its handle via ref. */
  async function mountHook(
    React: typeof import("react"),
    createRoot: typeof import("react-dom/client").createRoot,
    act: (cb: () => Promise<void> | void) => Promise<void>,
    deps: Record<string, unknown>,
  ): Promise<{ handleRef: { current: Handle | null }; root: any; host: any }> {
    const { useChatRuntime } = await import("../src/chat/runtime");
    const handleRef: { current: Handle | null } = { current: null };
    const Harness = () => {
      const h = useChatRuntime(deps as never);
      handleRef.current = { send: h.send, pendingAskUser: (h as any).pendingAskUser };
      return null;
    };
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    return { handleRef, root, host };
  }

  test("send() routes to api.answer when pendingAskUser has no options (free-form mode)", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act as (cb: () => Promise<void> | void) => Promise<void>;
    const { FrameBus } = await import("../src/chat/bus");

    const calls: SpyCall[] = [];
    const api = makeApi(calls);
    const bus = new FrameBus();

    const { handleRef, root } = await mountHook(React, createRoot, act, {
      bus, api, chatId: "chat-1",
    });

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "chat-1", run_id: "r1" } as never);
      bus.emit({
        type: "chat.tool_use",
        chat_id: "chat-1",
        run_id: "r1",
        tool_call_id: "tu-1",
        name: "ask_user",
        input: { question: "your name?" },
      } as never);
    });

    await act(async () => {
      await handleRef.current!.send("world");
    });

    const kinds = calls.map((c) => c.kind);
    expect(kinds).toContain("answer");
    const ans = calls.find((c) => c.kind === "answer") as
      | Extract<SpyCall, { kind: "answer" }>
      | undefined;
    expect(ans?.text).toBe("world");
    expect(ans?.toolUseId).toBe("tu-1");
    expect(ans?.cid).toBe("chat-1");
    expect(kinds).not.toContain("post");

    root.unmount();
  });

  test("send() is inert + toast when pendingAskUser has options (buttons-only)", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act as (cb: () => Promise<void> | void) => Promise<void>;
    const { FrameBus } = await import("../src/chat/bus");

    const calls: SpyCall[] = [];
    const api = makeApi(calls);
    const bus = new FrameBus();
    const toasts: string[] = [];

    const { handleRef, root } = await mountHook(React, createRoot, act, {
      bus,
      api,
      chatId: "chat-1",
      onComposerToast: (m: string) => toasts.push(m),
    });

    await act(async () => {
      bus.emit({ type: "run.start", chat_id: "chat-1", run_id: "r1" } as never);
      bus.emit({
        type: "chat.tool_use",
        chat_id: "chat-1",
        run_id: "r1",
        tool_call_id: "tu-1",
        name: "ask_user",
        input: { question: "color?", options: ["red", "blue"] },
      } as never);
    });

    await act(async () => {
      await handleRef.current!.send("typing...");
    });

    expect(calls).toEqual([]);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toMatch(/options/i);

    root.unmount();
  });

  test("send() falls through to postMessage when no pendingAskUser", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as any).act as (cb: () => Promise<void> | void) => Promise<void>;
    const { FrameBus } = await import("../src/chat/bus");

    const calls: SpyCall[] = [];
    const api = makeApi(calls);
    const bus = new FrameBus();

    const { handleRef, root } = await mountHook(React, createRoot, act, {
      bus, api, chatId: "chat-1",
    });

    await act(async () => {
      await handleRef.current!.send("plain text");
    });

    const kinds = calls.map((c) => c.kind);
    expect(kinds).toContain("post");
    expect(kinds).not.toContain("answer");

    root.unmount();
  });
});
