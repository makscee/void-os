/**
 * VOS-186 E2E: Dashboard skill-run UX — stop control, back-nav stacking fix, input-required skills
 *
 * Verifies:
 * 1. Stop control kills the vc process and marks the session stopped.
 * 2. Back-to-dashboard navigation yields a single root view (no stacked wrapper headers).
 * 3. needs_input skills (deep-research) gate the run behind a text field + Run button.
 *    - Empty field blocks submit (required attribute).
 *    - Filled field navigates to /s/:uuid.
 * 4. Non-flagged skill (smoke-test) still runs immediately on click (no regression).
 *
 * Run: bun run tests/e2e-vos-186-skill-run-ux.ts
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const WORKTREE = "/Users/admin/void-os-wt/VOS-186";
const VAULT = "/tmp/void-os-e2e-vos186";
const PORT = 4394;
const BASE = `http://localhost:${PORT}`;

const FAKE_RUNNER_SLEEP = `${WORKTREE}/tests/fixtures/fake-runner-sleep.sh`;
const FAKE_RUNNER = `${WORKTREE}/tests/fixtures/fake-runner.sh`;

// Set up vault
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "sessions"), { recursive: true });

// Config with two runners — sleep runner for Stop tests, instant runner for regression test.
// The default runner is the sleep one; regression test overrides per launch.
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT,
  onboarded: true,
  skills: [],
  answers: {},
  port: PORT,
  runners: [
    { label: "sleep", command: `${FAKE_RUNNER_SLEEP} --` },
    { label: "instant", command: `${FAKE_RUNNER} --` },
  ],
  defaultRunner: "sleep",
}, null, 2));

console.log("Starting void-os server on port", PORT, "...");
const server = spawn("bun", ["run", "src/cli.ts", "serve", "--no-open"], {
  cwd: WORKTREE,
  env: { ...process.env, VOID_OS_VAULT: VAULT, VOID_OS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));

// Wait for server to start
await new Promise<void>((r) => setTimeout(r, 2000));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

let ok = false;

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`ASSERT FAIL: ${msg}`); process.exit(1); }
}

try {
  // =========================================================================
  // Fix 1: Stop control kills the child process and marks session stopped
  // =========================================================================
  console.log("\n--- Fix 1: Stop control ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded.");

  // Launch smoke-test with the sleep runner (default)
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("button.skill-chip", { timeout: 5000 }),
  ]);

  const stopSessionUrl = page.url();
  const stopMatch = stopSessionUrl.match(/\/s\/([0-9a-f-]{36})/);
  assert(!!stopMatch, `No UUID in URL: ${stopSessionUrl}`);
  const stopUuid = stopMatch![1];
  console.log("Stop session UUID:", stopUuid);

  // Wait for the sleep runner to write body.html
  await new Promise<void>((r) => setTimeout(r, 1500));

  // Capture the child pid before stopping
  const pidFile = join(VAULT, "sessions", stopUuid, "vc.pid");
  let childPid: number | null = null;
  if (existsSync(pidFile)) {
    childPid = parseInt(readFileSync(pidFile, "utf8"), 10);
    console.log("Child PID:", childPid);
  } else {
    console.warn("vc.pid not found — sleep runner may have exited already");
  }

  // Screenshot before stop
  await page.screenshot({ path: "/tmp/vos-186-01-before-stop.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-01-before-stop.png");

  // Click the Stop button
  console.log("Clicking Stop button...");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("form.stop-form button", { timeout: 5000 }),
  ]);
  console.log("Stop submitted, navigated to:", page.url());

  // Give the OS a moment to reap the process
  await new Promise<void>((r) => setTimeout(r, 200));

  // Assert stopped.txt exists
  const stoppedPath = join(VAULT, "sessions", stopUuid, "stopped.txt");
  assert(existsSync(stoppedPath), `stopped.txt not found at ${stoppedPath}`);
  console.log("stopped.txt exists ✓");

  // Assert vc.pid is gone
  assert(!existsSync(pidFile), `vc.pid should have been removed after stop`);
  console.log("vc.pid removed ✓");

  // Assert child process is no longer alive
  if (childPid !== null) {
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    assert(!alive, `Child process ${childPid} should be dead after Stop`);
    console.log(`Child process ${childPid} is dead ✓`);
  }

  await page.screenshot({ path: "/tmp/vos-186-01-stopped.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-01-stopped.png");
  console.log("Fix 1 PASSED: Stop control kills child and marks session stopped.");

  // =========================================================================
  // Fix 2: Back-nav yields a single root view — no stacked wrapper headers
  // =========================================================================
  console.log("\n--- Fix 2: Back-nav single wrapper ---");

  // Seed a session whose body has a back-to-dashboard link
  const backnav = "backnav-uuid-vos186";
  const backnavDir = join(VAULT, "sessions", backnav);
  mkdirSync(backnavDir, { recursive: true });
  writeFileSync(join(backnavDir, "body.html"), `<h1>all set</h1><a href="/" target="_top" id="back-link">back to dashboard</a>`);
  writeFileSync(join(backnavDir, "session-meta.json"), JSON.stringify({ skill: "smoke-test", launchedAt: Date.now(), text: "", runner: `${FAKE_RUNNER} --` }));

  // Navigate to the session shell
  await page.goto(`${BASE}/s/${backnav}`, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Session shell loaded:", page.url());

  // Count shell-headers before clicking back
  const headersBefore = await page.$$(".shell-header");
  console.log("Headers before click:", headersBefore.length);
  assert(headersBefore.length === 1, `Expected 1 .shell-header before click, got ${headersBefore.length}`);

  await page.screenshot({ path: "/tmp/vos-186-02-session-view.png", fullPage: false });

  // Click the back link inside the iframe body
  const iframe = page.frameLocator("iframe#f");
  await iframe.locator("#back-link").waitFor({ timeout: 5000 });
  await iframe.locator("#back-link").click();

  // Wait for navigation
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  await new Promise<void>((r) => setTimeout(r, 500));

  console.log("After clicking back link, URL:", page.url());

  // Assert we're on the dashboard (/) or at least no stacked .shell-header
  const headersAfter = await page.$$(".shell-header");
  console.log("Shell-headers after back-nav:", headersAfter.length);
  assert(headersAfter.length <= 1, `Expected ≤1 .shell-header after back-nav, got ${headersAfter.length} (stacking bug!)`);

  // Also assert we're on the dashboard
  const urlAfter = page.url();
  const isOnDashboard = urlAfter === BASE + "/" || urlAfter === BASE;
  console.log("On dashboard:", isOnDashboard, "(URL:", urlAfter + ")");
  assert(isOnDashboard, `Expected to be on dashboard after back-nav, got: ${urlAfter}`);

  // Assert skill-chips visible (dashboard rendered)
  const chips = await page.$$(".skill-chips");
  assert(chips.length > 0, "Expected skill-chips on dashboard after back-nav");

  await page.screenshot({ path: "/tmp/vos-186-02-single-wrapper.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-02-single-wrapper.png");
  console.log("Fix 2 PASSED: Back-nav yields single root dashboard view.");

  // =========================================================================
  // Fix 3: needs_input gate — deep-research requires a query before launch
  // =========================================================================
  console.log("\n--- Fix 3: needs_input gate (deep-research) ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded for input-gate test.");

  // Find the needs-input chip for deep-research
  const needsInputForm = page.locator("form.skill-chip-form.needs-input").first();
  await needsInputForm.waitFor({ timeout: 5000 });
  console.log("Found needs-input form ✓");

  const inputField = needsInputForm.locator("input[name=text]");
  const runButton = needsInputForm.locator("button.skill-chip-run");

  // Assert input is required attribute
  const isRequired = await inputField.getAttribute("required");
  assert(isRequired !== null, "needs-input field should have required attribute");
  console.log("Input has required attribute ✓");

  await page.screenshot({ path: "/tmp/vos-186-03-input-gate.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-03-input-gate.png");

  // Try clicking Run with empty field — URL should not change (browser blocks required)
  const urlBefore = page.url();
  await runButton.click();
  await new Promise<void>((r) => setTimeout(r, 300));
  const urlAfterEmpty = page.url();
  assert(urlAfterEmpty === urlBefore, `Submit with empty required field should not navigate. Was: ${urlBefore}, now: ${urlAfterEmpty}`);
  console.log("Empty submit blocked by required attribute ✓");

  // Now fill the field with a query and submit
  const query = "What is the current state of AI alignment research?";
  await inputField.fill(query);
  console.log("Filled query:", query);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    runButton.click(),
  ]);

  const inputSessionUrl = page.url();
  // Must land on /s/:uuid shell — NOT bare /s/:uuid/send (VOS-186 v2 fix)
  const inputMatch = inputSessionUrl.match(/^http:\/\/[^/]+\/s\/([0-9a-f-]{36})$/);
  assert(
    !!inputMatch,
    `Expected navigation to /s/:uuid (shell), got: ${inputSessionUrl} — wrapper would be missing if URL ends in /send`,
  );
  const inputUuid = inputMatch![1];
  console.log("Navigated to session shell:", inputSessionUrl, "✓");

  // Assert exactly one .shell-header — shell wrapper must be present after /send flow
  const shellHeaders = await page.$$(".shell-header");
  assert(
    shellHeaders.length === 1,
    `Expected exactly 1 .shell-header on running-session view, got ${shellHeaders.length} (wrapper missing or stacked!)`,
  );
  console.log("Shell wrapper present (1 .shell-header) ✓");

  // Assert Stop control is visible inside the wrapper
  const stopBtn = await page.$("form.stop-form button");
  assert(stopBtn !== null, "Stop button (form.stop-form button) must be present in the shell wrapper");
  console.log("Stop control present in wrapper ✓");

  // Assert back-nav link is present
  const backLink = await page.$("a.back-link");
  assert(backLink !== null, "Back-nav link (a.back-link) must be present");
  console.log("Back-nav link present ✓");

  console.log("Input session UUID:", inputUuid);

  // Wait a moment for session-meta to be written
  await new Promise<void>((r) => setTimeout(r, 500));

  // Assert the session-meta.json has the typed query as text
  const inputMetaPath = join(VAULT, "sessions", inputUuid, "session-meta.json");
  assert(existsSync(inputMetaPath), `session-meta.json not found for input session ${inputUuid}`);
  const inputMeta = JSON.parse(readFileSync(inputMetaPath, "utf8"));
  console.log("Session meta text:", inputMeta.text);
  assert(
    inputMeta.text === query || inputMeta.text.includes("AI alignment"),
    `Expected query "${query}" in session-meta.text, got: "${inputMeta.text}"`,
  );
  console.log("Query reached session-meta.json ✓");

  await page.screenshot({ path: "/tmp/vos-186-03-input-launched.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-03-input-launched.png");
  console.log("Fix 3 PASSED: deep-research gates run behind input + Run button; running-session view retains wrapper + Stop control.");

  // =========================================================================
  // Fix 4: No regression — smoke-test (non-flagged) still runs immediately
  // =========================================================================
  console.log("\n--- Fix 4: No regression (smoke-test runs immediately) ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded for regression test.");

  // Find a plain (non-gated) chip — should have class="skill-chip" button
  const plainChip = page.locator("button.skill-chip").first();
  await plainChip.waitFor({ timeout: 5000 });
  console.log("Found plain skill-chip ✓");

  // Click it — should navigate without needing a query field
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    plainChip.click(),
  ]);

  const regressionUrl = page.url();
  const regressionMatch = regressionUrl.match(/\/s\/([0-9a-f-]{36})/);
  assert(!!regressionMatch, `Expected navigation to /s/:uuid on plain chip click, got: ${regressionUrl}`);
  console.log("Plain chip navigated to session:", regressionUrl, "✓");

  await page.screenshot({ path: "/tmp/vos-186-04-no-regression.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-04-no-regression.png");
  console.log("Fix 4 PASSED: Non-flagged skill still runs immediately on click.");

  ok = true;
  console.log("\n=== SUCCESS: All three VOS-186 fixes verified via Playwright ===");
  console.log("  Fix 1: Stop control kills child + marks session stopped");
  console.log("  Fix 2: Back-nav yields single root dashboard (no stacked wrapper headers)");
  console.log("  Fix 3: deep-research gates run behind input field + Run button");
  console.log("  Fix 4: Non-flagged skill (smoke-test) still runs immediately (no regression)");

} finally {
  await browser.close();
  server.kill();
  if (!ok) process.exit(1);
}
