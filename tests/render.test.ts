import { expect, test } from "bun:test";
import { placeholderBody, renderDashboard, renderShell, workingPage, stoppedBody, renderChatThread } from "../src/render.ts";

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
    [{ dir: "/c/skills/deep-research", name: "deep-research", description: "Research.", needsInput: false, inputLabel: "" }],
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

test("renderShell includes a Stop control posting to /s/:uuid/stop", () => {
  const html = renderShell("abc-uuid", "/tmp/v", "deep-research");
  expect(html).toContain('action="/s/abc-uuid/stop"');
  expect(html.toLowerCase()).toContain("stop");
  expect(html).toContain("stop-btn");
});

// VOS-187: stoppedBody and SSE teardown tests.
test("stoppedBody is a clean terminal document with no spinner", () => {
  const html = stoppedBody("onboarding");
  expect(html).toContain("stopped");
  expect(html).not.toContain("spinner");
  expect(html).not.toContain("Starting Claude Code");
  expect(html).toContain("onboarding");
});

test("renderShell SSE client closes the stream on a terminal status", () => {
  const shell = renderShell("u-1", "/tmp/vault", "onboarding");
  expect(shell).toContain("/s/u-1/status");
  expect(shell).toContain("es.close()");
});

// VOS-187: Universal modal replaces needs_input gated chip + single-click chip.
// Both flagged and unflagged skills now open a modal — no direct submit, no needs-input class.
import type { CatalogSkill } from "../src/catalog.ts";

test("every skill chip opens the universal modal — no single-click submit", () => {
  const skills: CatalogSkill[] = [
    { dir: "/c/onboarding", name: "onboarding", description: "Set up your void-os profile.", needsInput: false, inputLabel: "" },
    { dir: "/c/deep-research", name: "deep-research", description: "Fan-out research.", needsInput: true, inputLabel: "Research query" },
  ];
  const html = renderDashboard(skills, [], { authed: true });
  // No chip is a bare submit button into /launch anymore — chips are modal triggers.
  expect(html).not.toContain('<button type="submit" class="skill-chip">');
  expect(html).not.toContain('class="skill-chip-run"'); // the old needs_input Run button is gone
  // Each skill has a modal-trigger carrying its name + description.
  expect(html).toContain('data-skill="onboarding"');
  expect(html).toContain('data-skill="deep-research"');
  expect(html).toContain("Set up your void-os profile.");
  expect(html).toContain("Fan-out research.");
  // inputLabel reused as placeholder hint
  expect(html).toContain("Research query");
});

test("modal has one optional free-text field (not required) + Launch/Cancel, posting to /launch", () => {
  const skills: CatalogSkill[] = [
    { dir: "/c/onboarding", name: "onboarding", description: "Set up your void-os profile.", needsInput: false, inputLabel: "" },
  ];
  const html = renderDashboard(skills, [], { authed: true });
  expect(html).toContain('id="launch-modal"');
  expect(html).toContain('action="/launch"');
  // text field is NOT required
  expect(html).toMatch(/<textarea[^>]*name="text"(?![^>]*\brequired\b)/);
  expect(html).toContain(">Launch<");
  expect(html).toContain(">Cancel<");
});

test("renderDashboard non-flagged skill renders modal-trigger chip (no old chip form)", () => {
  const skills = [
    { dir: "/d", name: "smoke-test", description: "y", needsInput: false, inputLabel: "" },
  ];
  const html = renderDashboard(skills as any, [], { authed: true });
  // Modal-trigger button present
  expect(html).toContain('data-skill="smoke-test"');
  // Old forms are gone
  expect(html).not.toContain('class="skill-chip-form needs-input"');
  expect(html).not.toContain('class="skill-chip-run"');
});

test("renderChatThread shows the transcript turns and the cold-context size", () => {
  const html = renderChatThread({
    thread: "general",
    transcript: "## user (t)\n\nhi\n\n## assistant (t)\n\nhello\n",
    cold: { bytes: 40, tokenEstimate: 10 },
  });
  expect(html).toContain("general");
  expect(html).toContain("hi");
  expect(html).toContain("hello");
  expect(html).toContain("10"); // token estimate surfaced
  expect(html).toContain("40"); // bytes surfaced
});

test("renderDashboard lists pending decisions when provided", () => {
  const html = renderDashboard([], [], { authed: true }, undefined, [
    { id: "dl-abc", question: "Push to prod?", options: ["yes", "no"],
      originExecId: "ex-1", context: "deploy void-admin", state: "pending",
      reply: null, createdAt: 1, resolvedAt: null },
  ]);
  expect(html).toContain("Pending decisions");
  expect(html).toContain("Push to prod?");
  expect(html).toContain("dl-abc");
});

test("renderDashboard omits the decisions section when none pending", () => {
  const html = renderDashboard([], [], { authed: true }, undefined, []);
  expect(html).not.toContain("Pending decisions");
});

// VOS-203: dashboard renders vault-installed skills (LiveSkillSummary shape, no inputLabel field)
test("renderDashboard renders chips for vault-installed skills (no inputLabel field)", () => {
  const skills = [
    { name: "onboarding", description: "First-run setup", version: "0.0.0" },
    { name: "organize", description: "Drain inbox into knowledge", version: "0.0.0" },
  ];
  const html = renderDashboard(skills as any, [], { authed: true });
  expect(html).toContain('data-skill="onboarding"');
  expect(html).toContain('data-skill="organize"');
  expect(html).toContain('optional input…'); // inputLabel fallback used, no crash
});
