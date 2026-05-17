import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

// Smoke test: ChatView.onOpen mounts a React root without throwing,
// onClose tears it down. Real Obsidian + assistant-ui rendering is verified
// visually; this catches blatant import / wiring breakage in CI.
describe("ChatView mount", () => {
  beforeAll(() => {
    const win = new Window();
    // Wire happy-dom globals so React + assistant-ui see a DOM.
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
    // assistant-ui / radix touch a few browser-only APIs that happy-dom
    // does not implement. Stub the ones our smoke test trips over.
    (globalThis as any).ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
    (globalThis as any).MutationObserver = (globalThis as any).MutationObserver
      ?? class { observe(){} disconnect(){} takeRecords(){ return []; } };
  });

  test("ChatView mounts and unmounts without throwing", async () => {
    // Stub Obsidian's ItemView surface that ChatView relies on.
    const containerEl = (globalThis as any).document.createElement("div");
    const _placeholder = (globalThis as any).document.createElement("div"); // children[0]
    const leafEl = (globalThis as any).document.createElement("div");        // children[1]
    containerEl.appendChild(_placeholder);
    containerEl.appendChild(leafEl);

    // Re-mock obsidian via a path alias before importing view.ts.
    // moment stub preserves the registry key so downstream test files that
    // need moment (e.g. format-relative-time.test.ts) are not broken when
    // the full suite runs in a single Bun process (require() caches objects).
    const obsidianMock = {
      ItemView: class {
        containerEl: HTMLElement = containerEl;
        constructor(_leaf: unknown) {}
      },
      WorkspaceLeaf: class {},
      moment: (_ts: number) => ({ fromNow: () => "" }),
    };
    const { mock } = await import("bun:test");
    mock.module("obsidian", () => obsidianMock);

    const { ChatView } = await import("../src/view");
    const view = new (ChatView as any)({});
    // ItemView base would normally provide containerEl; our mock did.
    (view as any).containerEl = containerEl;
    // Augment createDiv polyfill the real Obsidian provides.
    (leafEl as any).empty = () => { while (leafEl.firstChild) leafEl.removeChild(leafEl.firstChild); };
    (leafEl as any).createDiv = (opts: { cls?: string }) => {
      const d = (globalThis as any).document.createElement("div");
      if (opts?.cls) d.className = opts.cls;
      leafEl.appendChild(d);
      return d;
    };

    await view.onOpen();
    // Verify the React mount div was created (className inspection avoids
    // happy-dom's CSS selector parser, which is fragile with our setup).
    const mountDiv = Array.from(leafEl.children).find(
      (el: any) => el.className === "void-os-chat-root",
    );
    expect(mountDiv).toBeTruthy();
    await view.onClose();
  });
});
