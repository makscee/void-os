import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

// Render test for assistant message markdown: confirms `**bold**` becomes a
// <strong> element and `- item` becomes <ul><li>. We render `react-markdown`
// directly — that's the library MarkdownTextPrimitive (from
// @assistant-ui/react-markdown) wraps. ChatRoot wires the primitive into
// MessagePrimitive.Parts' Text slot; the primitive in turn pipes text to
// react-markdown. Verifying react-markdown's output here keeps the test
// hermetic — no need to spin up an assistant-ui runtime in happy-dom.
describe("assistant markdown rendering", () => {
  beforeAll(() => {
    const win = new Window();
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
  });

  test("renders **bold** as <strong> and `- item` as <ul><li>", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const ReactMarkdown = (await import("react-markdown")).default;

    const md = "Hello **world**\n\n- one\n- two\n";
    const html = renderToStaticMarkup(
      React.createElement(ReactMarkdown as any, null, md),
    );

    expect(html).toContain("<strong>world</strong>");
    // jsdom-style serialization: <ul><li>one</li><li>two</li></ul> (possibly
    // with surrounding whitespace). Assert the structural pieces.
    expect(html).toMatch(/<ul[^>]*>/);
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });
});
