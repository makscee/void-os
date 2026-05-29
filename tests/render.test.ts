import { expect, test } from "bun:test";
import { placeholderBody, renderDashboard, renderShell, workingPage } from "../src/render.ts";

test("placeholder body has a title so it lists + sorts", () => {
  expect(placeholderBody()).toContain("<title>");
  expect(placeholderBody()).toContain("starting");
});

test("working page contains 'received'", () => {
  expect(workingPage()).toContain("received");
});

test("working page shows submitted field values", () => {
  const html = workingPage({ name: "Alice", goal: "learn TypeScript" });
  expect(html).toContain("Alice");
  expect(html).toContain("learn TypeScript");
  expect(html).toContain("name");
  expect(html).toContain("goal");
});

test("working page includes elapsed timer script", () => {
  const html = workingPage();
  expect(html).toContain("timer");
  expect(html).toContain("elapsed");
  expect(html).toContain("script");
});

test("working page escapes XSS in field values", () => {
  const html = workingPage({ name: '<script>alert(1)</script>' });
  expect(html).not.toContain('<script>alert(1)');
  expect(html).toContain("&lt;script&gt;");
});

test("dashboard shows skill chips and session rows in Option 1 style", () => {
  const html = renderDashboard(
    [{ dir: "/c/skills/deep-research", name: "deep-research", description: "Research." }],
    [{ uuid: "u1", title: "T1", mtimeMs: 1, error: false, status: "complete", skill: "deep-research" }],
    { authed: true },
  );
  expect(html).toContain("deep-research");
  expect(html).toContain('action="/launch"');
  expect(html).toContain("/s/u1");
  expect(html).toContain("relay ✓");
  expect(html).toContain("skill-chip");
  expect(html).toContain("session-row");
});

test("dashboard shows error flag for errored session", () => {
  const html = renderDashboard(
    [],
    [{ uuid: "err-uuid", title: "Boom", mtimeMs: 1, error: true, status: "error", skill: "" }],
    { authed: false },
  );
  expect(html).toContain("relay ✗");
  expect(html).toContain("session-dot");
  expect(html).toContain("err"); // error dot class
});

test("dashboard session dot has awaiting class when status is awaiting", () => {
  const html = renderDashboard(
    [],
    [{ uuid: "a1", title: "Awaiting", mtimeMs: 1, error: false, status: "awaiting", skill: "" }],
    { authed: true },
  );
  expect(html).toContain("await");
});

test("shell embeds the body iframe + SSE reload + vault-anchored resume cmd", () => {
  const html = renderShell("u1", "/home/user/void-os");
  expect(html).toContain('src="/s/u1/body"');
  expect(html).toContain("/s/u1/stream");
  expect(html).toContain("--resume u1");
  // vault path must appear so user knows where to cd
  expect(html).toContain("/home/user/void-os");
});

test("shell has click-to-copy button with resume command", () => {
  const html = renderShell("u1", "/home/user/vault");
  expect(html).toContain("copy-btn");
  expect(html).toContain("navigator.clipboard");
  expect(html).toContain("✓ copied");
  // must contain the full resume command in JS
  expect(html).toContain("vc -- --resume u1");
});

test("shell header is compact (36px min-height)", () => {
  const html = renderShell("u1", "/vault");
  expect(html).toContain("36px");
  expect(html).toContain("back-link");
  expect(html).toContain("← all");
});

test("shell escapes special chars in uuid", () => {
  const html = renderShell('abc"def', "/vault");
  expect(html).not.toContain('"def');
  expect(html).toContain("&quot;");
});

const TWO = { runners: [{ label: "vc (relay)", command: "vc --" }, { label: "artem", command: "claude_artem" }], defaultRunner: "vc (relay)" };
const ONE = { runners: [{ label: "vc (relay)", command: "vc --" }], defaultRunner: "vc (relay)" };

test("renders Run as select with default selected when >1 runner", () => {
  const html = renderDashboard([{ name: "smoke-test", description: "x", dir: "/d" } as any], [], { authed: true }, TWO);
  expect(html).toContain('id="runner-select"');
  expect(html).toContain('<option value="artem"');
  expect(html).toContain('value="vc (relay)" selected');
  expect(html).toContain('name="runner"'); // hidden input on chip forms
});

test("hides Run as select when only one runner", () => {
  const html = renderDashboard([{ name: "smoke-test", description: "x", dir: "/d" } as any], [], { authed: true }, ONE);
  expect(html).not.toContain('id="runner-select"');
});

test("renderShell includes the collapsible transcript drawer wired to /transcript", () => {
  const html = renderShell("abc12345-0000-1111-2222-333344445555", "/Users/admin/void-os");
  expect(html).toContain('id="drawer-bar"');
  expect(html).toContain('id="drawer-panel"');
  expect(html).toContain("/s/abc12345-0000-1111-2222-333344445555/transcript");
  expect(html).toContain("drawer-open");
  expect(html).toContain("setInterval");
});

// Bug 2: header shows session name, not raw uuid
test("shell header shows session name when provided", () => {
  const html = renderShell("u1", "/vault", "smoke-test");
  expect(html).toContain("smoke-test");
  // should NOT show the raw uuid in the session-name slot
  const nameSlot = html.match(/class="session-name"[^>]*>([^<]*)</)?.[1] ?? "";
  expect(nameSlot).not.toBe("u1");
  expect(nameSlot).toContain("smoke-test");
});

test("shell header falls back to truncated uuid when no name provided", () => {
  const html = renderShell("abc12345-0000-1111-2222-333344445555", "/vault");
  const nameSlot = html.match(/class="session-name"[^>]*>([^<]*)</)?.[1] ?? "";
  expect(nameSlot).toContain("abc12345");
});

test("shell header escapes name to prevent XSS", () => {
  const html = renderShell("u1", "/vault", '<script>bad</script>');
  expect(html).not.toContain('<script>bad</script>');
  expect(html).toContain("&lt;script&gt;");
});
