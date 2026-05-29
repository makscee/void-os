import { expect, test } from "bun:test";
import { placeholderBody, renderDashboard, renderShell, workingPage } from "../src/render.ts";

test("placeholder body has a title so it lists + sorts", () => {
  expect(placeholderBody()).toContain("<title>");
  expect(placeholderBody()).toContain("starting");
});

test("working page contains 'received'", () => {
  expect(workingPage()).toContain("received");
});

test("dashboard shows skill buttons and session rows", () => {
  const html = renderDashboard(
    [{ dir: "/c/skills/deep-research", name: "deep-research", description: "Research." }],
    [{ uuid: "u1", title: "T1", mtimeMs: 1, error: false }],
    { authed: true },
  );
  expect(html).toContain("deep-research");
  expect(html).toContain('action="/launch"');
  expect(html).toContain("/s/u1");
  expect(html).toContain("authed");
});

test("dashboard shows error flag for errored session", () => {
  const html = renderDashboard(
    [],
    [{ uuid: "err-uuid", title: "Boom", mtimeMs: 1, error: true }],
    { authed: false },
  );
  expect(html).toContain("⚠️");
  expect(html).toContain("not authed");
});

test("shell embeds the body iframe + SSE reload + inspect command", () => {
  const html = renderShell("u1");
  expect(html).toContain('src="/s/u1/body"');
  expect(html).toContain("/s/u1/stream");
  expect(html).toContain("vc -- --resume u1");
});

test("shell escapes special chars in uuid", () => {
  const html = renderShell('abc"def');
  expect(html).not.toContain('"def');
  expect(html).toContain("&quot;");
});
