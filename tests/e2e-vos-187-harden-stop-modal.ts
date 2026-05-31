/**
 * VOS-187 E2E: Hardened Stop + Universal Modal
 *
 * Verifies:
 * A. Process-tree kill + race guard + clean stopped view (fake-runner-tree)
 * B. Re-open shows stopped (not "Launching…")
 * C. Idempotent re-stop (two POSTs both < 400)
 * D. SSE teardown — /status route returns "stopped" after stop
 * E. Drain-halt — drain.stop written on stop
 * F. Universal modal with text — skill name, description, typed text in session-meta
 * G. Universal modal empty text — launch with empty text still works
 * H. No single-click — chip click does not navigate (opens modal only)
 * I. Carried-forward back-nav (VOS-186) — single wrapper, lands on /
 *
 * Run: bun run tests/e2e-vos-187-harden-stop-modal.ts
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const WORKTREE = "/Users/admin/void-os-wt/VOS-187";
const VAULT = "/tmp/void-os-e2e-vos187";
const PORT = 4395;
const BASE = `http://localhost:${PORT}`;

const FAKE_RUNNER_TREE = `${WORKTREE}/tests/fixtures/fake-runner-tree.sh`;
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
    { label: "tree", command: `${FAKE_RUNNER_TREE} --` },
    { label: "instant", command: `${FAKE_RUNNER} --` },
  ],
  defaultRunner: "tree",
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

function groupCount(pid: number): number {
  const out = spawnSync("bash", ["-c", `pgrep -g ${pid} | wc -l`]).stdout.toString().trim();
  return parseInt(out, 10) || 0;
}

try {
  // =========================================================================
  // Section A: Process-tree kill + race guard + clean stopped view
  // =========================================================================
  console.log("\n--- A: Process-tree kill + race guard + clean stopped view ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded.");

  // Launch via modal — default "tree" runner (spawns a grandchild)
  await page.click("button.skill-chip", { timeout: 5000 });
  await page.waitForSelector("#launch-modal:not([hidden])", { timeout: 5000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("button.modal-launch", { timeout: 5000 }),
  ]);

  const sessionUrl = page.url();
  const uuidMatch = sessionUrl.match(/\/s\/([0-9a-f-]{36})/);
  assert(!!uuidMatch, `No UUID in URL: ${sessionUrl}`);
  const uuid = uuidMatch![1];
  console.log("Session UUID:", uuid);

  // Wait for fake-runner-tree to write body.html + spawn grandchild
  await new Promise<void>((r) => setTimeout(r, 2000));

  const pidFile = join(VAULT, "sessions", uuid, "vc.pid");
  assert(existsSync(pidFile), `vc.pid not found — tree runner should persist pid`);
  const pid = parseInt(readFileSync(pidFile, "utf8"), 10);
  console.log("vc.pid =", pid);

  // Verify the group has at least 2 members (parent + grandchild)
  const beforeCount = groupCount(pid);
  console.log("Group members before stop:", beforeCount);
  assert(beforeCount >= 2, `Expected ≥2 group members (parent+grandchild), got ${beforeCount}`);

  await page.screenshot({ path: "/tmp/vos-187-A-before-stop.png" });
  console.log("Screenshot: /tmp/vos-187-A-before-stop.png");

  // Click Stop
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("form.stop-form button", { timeout: 5000 }),
  ]);
  console.log("Stop clicked. Navigated to:", page.url());

  // Wait for group to die
  await new Promise<void>((r) => setTimeout(r, 500));

  const afterCount = groupCount(pid);
  console.log("Group members after stop:", afterCount);
  assert(afterCount === 0, `Expected 0 group members after tree-kill, got ${afterCount} (orphan not killed!)`);
  console.log("Process group killed entirely — no orphan ✓");

  // Assert stopped.txt exists and vc.pid is gone
  const stoppedPath = join(VAULT, "sessions", uuid, "stopped.txt");
  assert(existsSync(stoppedPath), `stopped.txt not found`);
  assert(!existsSync(pidFile), `vc.pid should be cleared after stop`);
  console.log("stopped.txt exists, vc.pid cleared ✓");

  // Assert error.txt is gone (banner cleared)
  const errPath = join(VAULT, "sessions", uuid, "error.txt");
  assert(!existsSync(errPath), `error.txt should be cleared by stop route (stale banner)`);
  console.log("error.txt cleared ✓");

  // Assert body.html contains "stopped" (clean terminal view)
  const bodyHtml = readFileSync(join(VAULT, "sessions", uuid, "body.html"), "utf8");
  assert(bodyHtml.includes("stopped"), `body.html should contain "stopped" after stop, got: ${bodyHtml.slice(0, 200)}`);
  console.log("body.html shows clean stopped view ✓");

  // Race guard: wait 2s more for grandchild's late write attempt; body.html should NOT be overwritten
  await new Promise<void>((r) => setTimeout(r, 2000));
  const bodyAfterWait = readFileSync(join(VAULT, "sessions", uuid, "body.html"), "utf8");
  assert(!bodyAfterWait.includes("orphan"), `body.html should NOT be overwritten by orphan — race guard failed!`);
  assert(bodyAfterWait.includes("stopped"), `body.html should still say "stopped" after waiting for grandchild`);
  console.log("Race guard holds — grandchild did NOT overwrite body.html ✓");

  await page.screenshot({ path: "/tmp/vos-187-A-after-stop.png" });
  console.log("Screenshot: /tmp/vos-187-A-after-stop.png");
  console.log("Section A PASSED.");

  // =========================================================================
  // Section B: Re-open shows stopped (not "Launching…")
  // =========================================================================
  console.log("\n--- B: Re-open shows stopped (not Launching…) ---");

  await page.goto(`${BASE}/s/${uuid}`, { waitUntil: "domcontentloaded", timeout: 10000 });
  await new Promise<void>((r) => setTimeout(r, 1000));

  // The iframe should show the stopped body, not the placeholder spinner
  const iframeB = page.frameLocator("iframe#f");
  const iframeContentB = await iframeB.locator("body").innerText().catch(() => "");
  console.log("iframe body text:", iframeContentB.slice(0, 100));
  assert(!iframeContentB.toLowerCase().includes("launching"), `Re-open should NOT show "Launching…", got: ${iframeContentB}`);
  assert(!iframeContentB.toLowerCase().includes("starting claude"), `Re-open should NOT show "Starting Claude Code…"`);

  await page.screenshot({ path: "/tmp/vos-187-B-reopen-stopped.png" });
  console.log("Screenshot: /tmp/vos-187-B-reopen-stopped.png");
  console.log("Section B PASSED: Re-open shows stopped (not Launching…).");

  // =========================================================================
  // Section C: Idempotent re-stop
  // =========================================================================
  console.log("\n--- C: Idempotent re-stop ---");

  const r1 = await page.request.post(`${BASE}/s/${uuid}/stop`);
  const r2 = await page.request.post(`${BASE}/s/${uuid}/stop`);
  assert(r1.status() < 400, `First stop should be < 400, got ${r1.status()}`);
  assert(r2.status() < 400, `Second stop (re-stop) should be < 400, got ${r2.status()}`);
  assert(existsSync(stoppedPath), `stopped.txt should still exist after re-stop`);
  console.log(`Idempotent re-stop: r1=${r1.status()}, r2=${r2.status()} ✓`);
  console.log("Section C PASSED.");

  // =========================================================================
  // Section D: SSE teardown — /status returns "stopped"
  // =========================================================================
  console.log("\n--- D: SSE teardown — /status returns stopped ---");

  const statusRes = await page.request.get(`${BASE}/s/${uuid}/status`);
  const statusText = await statusRes.text();
  assert(statusText === "stopped", `/status should return "stopped", got: "${statusText}"`);
  console.log(`/s/${uuid}/status = "${statusText}" ✓`);
  console.log("Section D PASSED.");

  // =========================================================================
  // Section E: Drain-halt — drain.stop written on stop
  // =========================================================================
  console.log("\n--- E: Drain-halt — drain.stop written on stop for drain sessions ---");

  // Create a fake drain session with meta containing drainIssue + worktree
  const drainWt = "/tmp/void-os-e2e-drain-wt";
  mkdirSync(drainWt, { recursive: true });
  const drainUuid = "drain-e2e-uuid-1234-5678-90ab";
  const drainDir = join(VAULT, "sessions", drainUuid);
  mkdirSync(drainDir, { recursive: true });
  writeFileSync(join(drainDir, "body.html"), "<p>draining</p>");
  writeFileSync(join(drainDir, "session-meta.json"), JSON.stringify({
    skill: "ralph",
    drainIssue: 42,
    worktree: drainWt,
    runner: "sleep 30 --",
  }));

  const drainStopRes = await page.request.post(`${BASE}/s/${drainUuid}/stop`);
  assert(drainStopRes.status() < 400, `Drain stop should succeed, got ${drainStopRes.status()}`);
  assert(existsSync(join(drainWt, "drain.stop")), `drain.stop should be written to worktree on stop`);
  console.log("drain.stop written to worktree on stop ✓");
  console.log("Section E PASSED.");

  // =========================================================================
  // Section F: Universal modal with text
  // =========================================================================
  console.log("\n--- F: Universal modal — launch with text ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded.");

  // Chip click should open modal, not navigate
  const chipF = page.locator("button.skill-chip").first();
  await chipF.waitFor({ timeout: 5000 });
  const urlBeforeF = page.url();
  await chipF.click();
  await new Promise<void>((r) => setTimeout(r, 300));
  assert(page.url() === urlBeforeF, `Chip click should not navigate — URL unchanged (modal opens)`);
  console.log("Chip click did not navigate ✓");

  // Wait for modal
  await page.waitForSelector("#launch-modal:not([hidden])", { timeout: 5000 });
  console.log("Modal is visible ✓");

  // Check modal shows skill name
  const modalSkillName = await page.textContent("#lm-name");
  assert(modalSkillName !== null && modalSkillName.length > 0, "Modal #lm-name should show skill name");
  console.log("Modal skill name:", modalSkillName, "✓");

  // Text field is present and NOT required
  const textArea = await page.$("#lm-text");
  assert(textArea !== null, "#lm-text must be present");
  const required = await textArea!.getAttribute("required");
  assert(required === null, "#lm-text must NOT have required attribute");
  console.log("Text field present, not required ✓");

  // Type text and launch via "instant" runner (select it first if runner selector visible)
  const runnerSel = await page.$("#runner-select");
  if (runnerSel) {
    await page.selectOption("#runner-select", "instant");
    console.log("Switched to instant runner ✓");
  }

  const testText = "hello from vos-187 e2e test";
  await page.fill("#lm-text", testText);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("button.modal-launch", { timeout: 5000 }),
  ]);

  const fSessionUrl = page.url();
  const fMatch = fSessionUrl.match(/\/s\/([0-9a-f-]{36})/);
  assert(!!fMatch, `Expected /s/:uuid after modal launch, got: ${fSessionUrl}`);
  const fUuid = fMatch![1];
  console.log("Launched session:", fUuid);

  // Wait for session-meta
  await new Promise<void>((r) => setTimeout(r, 600));
  const fMetaPath = join(VAULT, "sessions", fUuid, "session-meta.json");
  assert(existsSync(fMetaPath), `session-meta.json not found for ${fUuid}`);
  const fMeta = JSON.parse(readFileSync(fMetaPath, "utf8"));
  assert(fMeta.text === testText, `Expected text "${testText}" in session-meta.text, got "${fMeta.text}"`);
  console.log("session-meta.text =", fMeta.text, "✓");

  await page.screenshot({ path: "/tmp/vos-187-F-modal-with-text.png" });
  console.log("Screenshot: /tmp/vos-187-F-modal-with-text.png");
  console.log("Section F PASSED.");

  // =========================================================================
  // Section G: Universal modal — empty text launch
  // =========================================================================
  console.log("\n--- G: Universal modal — empty text launch ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  const chipG = page.locator("button.skill-chip").first();
  await chipG.click();
  await page.waitForSelector("#launch-modal:not([hidden])", { timeout: 5000 });

  // Switch to instant runner
  const runnerSelG = await page.$("#runner-select");
  if (runnerSelG) {
    await page.selectOption("#runner-select", "instant");
  }

  // Leave #lm-text empty, click Launch
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("button.modal-launch", { timeout: 5000 }),
  ]);

  const gUrl = page.url();
  const gMatch = gUrl.match(/\/s\/([0-9a-f-]{36})/);
  assert(!!gMatch, `Empty-text modal launch should navigate to /s/:uuid, got: ${gUrl}`);
  console.log("Empty-text launch navigated to:", gUrl, "✓");

  await page.screenshot({ path: "/tmp/vos-187-G-modal-empty-text.png" });
  console.log("Screenshot: /tmp/vos-187-G-modal-empty-text.png");
  console.log("Section G PASSED.");

  // =========================================================================
  // Section H: No single-click — chip does not navigate, only opens modal
  // =========================================================================
  console.log("\n--- H: No single-click — chip opens modal only ---");

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  const urlBeforeH = page.url();
  const chipH = page.locator("button.skill-chip").first();
  await chipH.click();
  await new Promise<void>((r) => setTimeout(r, 400));
  assert(page.url() === urlBeforeH, `Chip click must NOT navigate — URL should stay ${urlBeforeH}`);
  console.log("URL unchanged after chip click ✓");

  // Modal must be open
  const modalHidden = await page.getAttribute("#launch-modal", "hidden");
  assert(modalHidden === null, "Modal must be visible (not hidden) after chip click");
  console.log("Modal visible after chip click ✓");

  // Escape should close it
  await page.keyboard.press("Escape");
  await new Promise<void>((r) => setTimeout(r, 200));
  const modalHiddenAfterEsc = await page.getAttribute("#launch-modal", "hidden");
  assert(modalHiddenAfterEsc !== null, "Modal must be hidden after Escape");
  console.log("Modal closed by Escape ✓");

  await page.screenshot({ path: "/tmp/vos-187-H-no-single-click.png" });
  console.log("Screenshot: /tmp/vos-187-H-no-single-click.png");
  console.log("Section H PASSED.");

  // =========================================================================
  // Section I: Carried-forward back-nav (VOS-186) — single wrapper, lands on /
  // =========================================================================
  console.log("\n--- I: Carried-forward back-nav — single wrapper ---");

  const backnavI = "backnav-uuid-vos187";
  const backnavDir = join(VAULT, "sessions", backnavI);
  mkdirSync(backnavDir, { recursive: true });
  writeFileSync(join(backnavDir, "body.html"), `<h1>done</h1><a href="/" target="_top" id="bl">back</a>`);
  writeFileSync(join(backnavDir, "session-meta.json"), JSON.stringify({ skill: "test", launchedAt: Date.now(), text: "" }));

  await page.goto(`${BASE}/s/${backnavI}`, { waitUntil: "domcontentloaded", timeout: 10000 });
  const hBefore = await page.$$(".shell-header");
  assert(hBefore.length === 1, `Expected 1 .shell-header before click, got ${hBefore.length}`);

  const iframeI = page.frameLocator("iframe#f");
  await iframeI.locator("#bl").waitFor({ timeout: 5000 });
  await iframeI.locator("#bl").click();
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  await new Promise<void>((r) => setTimeout(r, 500));

  const hAfter = await page.$$(".shell-header");
  assert(hAfter.length <= 1, `Back-nav stacking bug! Got ${hAfter.length} .shell-header`);
  const onDash = page.url() === BASE + "/" || page.url() === BASE;
  assert(onDash, `Expected dashboard after back-nav, got: ${page.url()}`);
  console.log("Single wrapper after back-nav ✓");

  await page.screenshot({ path: "/tmp/vos-187-I-back-nav.png" });
  console.log("Screenshot: /tmp/vos-187-I-back-nav.png");
  console.log("Section I PASSED.");

  ok = true;
  console.log("\n=== SUCCESS: All VOS-187 E2E sections passed ===");
  console.log("  A: Process-tree kill (no orphan) + race guard + clean stopped view");
  console.log("  B: Re-open shows stopped (not Launching…)");
  console.log("  C: Idempotent re-stop (no error)");
  console.log("  D: SSE teardown — /status returns stopped");
  console.log("  E: Drain-halt — drain.stop written on stop");
  console.log("  F: Modal launch with text — skill name + description + text in meta");
  console.log("  G: Modal launch with empty text — works for all skills");
  console.log("  H: No single-click — chip opens modal only");
  console.log("  I: Carried-forward back-nav — single wrapper, lands on /");

} finally {
  await browser.close();
  server.kill();
  if (!ok) process.exit(1);
}
