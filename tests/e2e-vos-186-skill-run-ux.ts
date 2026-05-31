/**
 * VOS-186+187 E2E: Dashboard skill-run UX — stop control, back-nav, universal modal
 *
 * Verifies (updated for VOS-187):
 * 1. Stop control kills the vc process group (tree-kill) and marks session stopped.
 * 2. Back-to-dashboard navigation yields a single root view (no stacked wrapper headers).
 * 3. Universal modal opens on chip click (no single-click launch); launch with text works.
 * 4. Launch with empty text also works (text field is not required).
 *
 * Run: bun run tests/e2e-vos-186-skill-run-ux.ts
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const WORKTREE = "/Users/admin/void-os-wt/VOS-187";
const VAULT = "/tmp/void-os-e2e-vos186";
const PORT = 4394;
const BASE = `http://localhost:${PORT}`;

const FAKE_RUNNER_SLEEP = `${WORKTREE}/tests/fixtures/fake-runner-sleep.sh`;
const FAKE_RUNNER = `${WORKTREE}/tests/fixtures/fake-runner.sh`;

// Set up vault
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "sessions"), { recursive: true });

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
  // Fix 1: Stop control kills the child process GROUP and marks session stopped
  // =========================================================================
  console.log("\n--- Fix 1: Stop control (tree-kill) ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded.");

  // Launch via the universal modal (VOS-187: all skills open modal, no single-click)
  await page.click("button.skill-chip", { timeout: 5000 });
  await page.waitForSelector("#launch-modal:not([hidden])", { timeout: 5000 });
  console.log("Modal opened ✓");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("button.modal-launch", { timeout: 5000 }),
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
  await new Promise<void>((r) => setTimeout(r, 300));

  // Assert stopped.txt exists
  const stoppedPath = join(VAULT, "sessions", stopUuid, "stopped.txt");
  assert(existsSync(stoppedPath), `stopped.txt not found at ${stoppedPath}`);
  console.log("stopped.txt exists ✓");

  // Assert vc.pid is gone
  assert(!existsSync(pidFile), `vc.pid should have been removed after stop`);
  console.log("vc.pid removed ✓");

  // Assert child process GROUP is no longer alive (tree-kill sends to whole group)
  if (childPid !== null) {
    let groupAlive = true;
    try { process.kill(-childPid, 0); } catch { groupAlive = false; }
    assert(!groupAlive, `Process group ${childPid} should be dead after Stop (tree-kill)`);
    console.log(`Process group ${childPid} is dead ✓`);
  }

  await page.screenshot({ path: "/tmp/vos-186-01-stopped.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-01-stopped.png");
  console.log("Fix 1 PASSED: Stop control kills process group and marks session stopped.");

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
  // Fix 3 (VOS-187): Universal modal — chip opens modal, not single-click launch
  // =========================================================================
  console.log("\n--- Fix 3: Universal modal — skill opens modal (not single-click) ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded for modal test.");

  const anyChip = page.locator("button.skill-chip").first();
  await anyChip.waitFor({ timeout: 5000 });
  console.log("Found skill chip ✓");

  const urlBefore3 = page.url();

  // Click chip — should open modal, NOT navigate
  await anyChip.click({ timeout: 5000 });
  await new Promise<void>((r) => setTimeout(r, 300));
  const urlAfter3 = page.url();
  assert(urlAfter3 === urlBefore3, `Clicking chip should not navigate (opens modal). Was: ${urlBefore3}, now: ${urlAfter3}`);
  console.log("Chip click did NOT navigate (modal opens) ✓");

  // Assert modal is visible
  await page.waitForSelector("#launch-modal:not([hidden])", { timeout: 5000 });
  console.log("Modal visible ✓");

  // Assert modal has skill name and textarea (NOT required)
  const lmText = await page.$("#lm-text");
  assert(lmText !== null, "#lm-text textarea must be present in modal");
  const isRequired3 = await lmText!.getAttribute("required");
  assert(isRequired3 === null, "Modal text field must NOT be required (optional for all skills)");
  console.log("Modal has optional text field ✓");

  // Fill query and launch
  const query = "What is the current state of AI alignment research?";
  await page.fill("#lm-text", query);
  console.log("Filled query:", query);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("button.modal-launch", { timeout: 5000 }),
  ]);

  const inputSessionUrl = page.url();
  const inputMatch = inputSessionUrl.match(/^http:\/\/[^/]+\/s\/([0-9a-f-]{36})$/);
  assert(!!inputMatch, `Expected navigation to /s/:uuid (shell), got: ${inputSessionUrl}`);
  const inputUuid = inputMatch![1];
  console.log("Navigated to session shell:", inputSessionUrl, "✓");

  // Assert exactly one .shell-header
  const shellHeaders = await page.$$(".shell-header");
  assert(shellHeaders.length === 1, `Expected 1 .shell-header, got ${shellHeaders.length}`);
  console.log("Shell wrapper present (1 .shell-header) ✓");

  const stopBtn3 = await page.$("form.stop-form button");
  assert(stopBtn3 !== null, "Stop button must be present in shell wrapper");
  console.log("Stop control present in wrapper ✓");

  // Assert back-nav link is present
  const backLink3 = await page.$("a.back-link");
  assert(backLink3 !== null, "Back-nav link (a.back-link) must be present");
  console.log("Back-nav link present ✓");

  // Wait for session-meta to be written
  await new Promise<void>((r) => setTimeout(r, 500));

  const inputMetaPath = join(VAULT, "sessions", inputUuid, "session-meta.json");
  assert(existsSync(inputMetaPath), `session-meta.json not found for ${inputUuid}`);
  const inputMeta = JSON.parse(readFileSync(inputMetaPath, "utf8"));
  console.log("Session meta text:", inputMeta.text);
  assert(
    inputMeta.text === query || inputMeta.text.includes("AI alignment"),
    `Expected query in session-meta.text, got: "${inputMeta.text}"`,
  );
  console.log("Query reached session-meta.json ✓");

  await page.screenshot({ path: "/tmp/vos-186-03-modal-launched.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-03-modal-launched.png");
  console.log("Fix 3 PASSED: Modal opens on chip click; launch with text works; wrapper + Stop retained.");

  // =========================================================================
  // Fix 4 (VOS-187): Empty text launch works — no required block
  // =========================================================================
  console.log("\n--- Fix 4: Modal launch with empty text is allowed ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded for empty-launch test.");

  const chip4 = page.locator("button.skill-chip").first();
  await chip4.click({ timeout: 5000 });
  await page.waitForSelector("#launch-modal:not([hidden])", { timeout: 5000 });
  console.log("Modal opened ✓");

  // Launch without any text — should still navigate (not blocked by required)
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("button.modal-launch", { timeout: 5000 }),
  ]);

  const emptyUrl = page.url();
  const emptyMatch = emptyUrl.match(/\/s\/([0-9a-f-]{36})/);
  assert(!!emptyMatch, `Expected navigation to /s/:uuid on empty-text launch, got: ${emptyUrl}`);
  console.log("Empty-text modal launch navigated to session ✓");

  await page.screenshot({ path: "/tmp/vos-186-04-empty-launch.png", fullPage: false });
  console.log("Screenshot saved: /tmp/vos-186-04-empty-launch.png");
  console.log("Fix 4 PASSED: Modal launch with empty text navigates to /s/:uuid (not blocked).");

  ok = true;
  console.log("\n=== SUCCESS: All VOS-186+187 fixes verified via Playwright ===");
  console.log("  Fix 1: Stop control kills process group + marks session stopped");
  console.log("  Fix 2: Back-nav yields single root dashboard (no stacked wrapper headers)");
  console.log("  Fix 3: Universal modal opens on chip click; launch with text works");
  console.log("  Fix 4: Modal launch with empty text is allowed (not blocked by required)");

} finally {
  await browser.close();
  server.kill();
  if (!ok) process.exit(1);
}
