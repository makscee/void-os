/**
 * VOS-211 E2E: htmx hypermedia loop — form→ack→body-advance→SSE-rerender.
 *
 * Drives the loop MECHANICALLY (no live LLM): seeds body.html with an hx-post form,
 * drives the browser to submit, asserts:
 *  (a) POST /act fires from the sandboxed iframe and receives an ack fragment (200 + "working"),
 *  (b) body.html advanced to workingPage on the daemon (send path wired correctly),
 *  (c) Simulated agent write of fresh body.html → SSE reload swaps iframe content.
 *
 * Note on ack-swap vs SSE timing: /act writes workingPage to body.html which triggers
 * the SSE reload (~1s later). The htmx swap into #status is visible briefly but the
 * SSE reload replaces it. We assert the ack at network level (response body), not DOM.
 *
 * Isolates deterministic wiring from LLM timing (CLAUDE.md proof rule 2).
 * Real-agent round-trip is Task D3 (master-run).
 *
 * Run: bun run tests/e2e-vos-211-htmx-loop.ts
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname_e2e = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname_e2e, "..");
const VAULT = "/tmp/void-os-e2e-vos211";
const PORT = 4401;
const BASE = `http://localhost:${PORT}`;
const EVIDENCE = "/Users/admin/hub/vault/work/evidence/VOS-211";
const BUN = process.execPath;

// ---- setup ----
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "sessions"), { recursive: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT,
  onboarded: true,
  skills: [],
  answers: {},
  port: PORT,
  runners: [{ label: "fake", command: `${REPO_ROOT}/tests/fixtures/fake-runner.sh --` }],
  defaultRunner: "fake",
}, null, 2));

// ---- seed a session with an htmx-form body.html ----
const UUID = "exec-e2e-htmx-211";
const sessDir = join(VAULT, "sessions", UUID);
mkdirSync(sessDir, { recursive: true });

// Session meta: interactive so it's treated as a live REPL
writeFileSync(join(sessDir, "session-meta.json"), JSON.stringify({
  skill: "htmx-form-demo",
  interactive: true,
  tmuxSession: `vos-run-${UUID}`,
  runner: `${REPO_ROOT}/tests/fixtures/fake-runner.sh --`,
}));

// body.html: a real htmx hx-post form using {{VOS_UUID}} sentinel
// (void-os substitutes it at serve time via GET /s/:uuid/body)
const FORM_BODY = `<!doctype html>
<html><head><title>VOS-211 demo</title></head><body>
<form hx-post="/s/{{VOS_UUID}}/act" hx-target="#status" hx-swap="innerHTML">
  <button name="choice" value="ship" id="ship-btn">Ship</button>
  <button name="choice" value="hold">Hold</button>
</form>
<div id="status">ready</div>
</body></html>`;
writeFileSync(join(sessDir, "body.html"), FORM_BODY);

console.log("=== VOS-211 E2E: htmx hypermedia loop ===");
console.log(`VAULT: ${VAULT}  PORT: ${PORT}  UUID: ${UUID}`);

const server = spawn(BUN, ["run", "src/cli.ts", "serve", "--no-open"], {
  cwd: REPO_ROOT,
  env: { ...process.env, VOID_OS_VAULT: VAULT, VOID_OS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout?.on("data", (d: Buffer) => process.stdout.write(`[daemon] ${d}`));
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[daemon] ${d}`));

// Wait for daemon to start
await new Promise<void>((r) => setTimeout(r, 3000));

let exitCode = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

function hardAssert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`HARD-FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

// Poll helper — polls until predicate returns truthy or timeout
async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  maxMs: number,
  intervalMs = 300,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Capture /act responses at network level (more reliable than DOM timing due to SSE reload race)
let actResponseBody = "";
let actResponseStatus = 0;
page.on("response", async (res) => {
  if (res.url().includes("/act")) {
    actResponseStatus = res.status();
    actResponseBody = await res.text().catch(() => "");
    console.log(`/act response: ${actResponseStatus} len=${actResponseBody.length} cors=${res.headers()["access-control-allow-origin"] ?? "none"}`);
  }
});
page.on("console", (msg) => {
  if (msg.type() === "error") console.log(`CONSOLE-ERR: ${msg.text()}`);
});

try {
  // --- Stage 1: Navigate to the session shell ---
  console.log(`\n=== Stage 1: Navigate to /s/${UUID} ===`);
  await page.goto(`${BASE}/s/${UUID}`, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.screenshot({ path: `${EVIDENCE}/e2e-stage1-shell.png` });
  console.log("Screenshot: e2e-stage1-shell.png");

  // Verify iframe is sandboxed
  const iframeSandbox = await page.$eval("iframe#f", (el) => (el as HTMLIFrameElement).getAttribute("sandbox"));
  hardAssert(iframeSandbox !== null && iframeSandbox.includes("allow-scripts"), `iframe has sandbox with allow-scripts (got: ${iframeSandbox})`);
  hardAssert(iframeSandbox !== null && !iframeSandbox.includes("allow-same-origin"), `iframe sandbox does NOT include allow-same-origin`);

  // The shell page has an iframe serving /s/:uuid/body
  const frame = page.frameLocator("iframe#f");

  // Wait for the iframe to load and show the form (htmx must have run substitution)
  const shipBtn = frame.locator("#ship-btn");
  await shipBtn.waitFor({ state: "visible", timeout: 10000 });
  console.log("PASS: iframe loaded, Ship button visible");

  // Verify {{VOS_UUID}} was substituted (form hx-post should contain real uuid)
  const formHtml = await frame.locator("form").innerHTML({ timeout: 5000 });
  hardAssert(!formHtml.includes("{{VOS_UUID}}"), "form HTML has no unreplaced {{VOS_UUID}} sentinel");

  // Verify htmx is loaded in the frame
  const htmxLoaded = await frame.locator("body").evaluate(() => typeof (window as any).htmx !== "undefined");
  hardAssert(htmxLoaded, "htmx runtime loaded inside the sandboxed iframe");

  await page.screenshot({ path: `${EVIDENCE}/e2e-stage2-form-visible.png` });
  console.log("Screenshot: e2e-stage2-form-visible.png");

  // --- Stage 2: Click Ship — POST /act fires, ack fragment returns ---
  console.log("\n=== Stage 2: Click Ship → POST /act → ack fragment ===");
  const bodyMtimeBefore = statSync(join(sessDir, "body.html")).mtimeMs;

  await shipBtn.click();

  // Wait for the /act response to arrive at network level
  const actFired = await pollUntil(() => actResponseStatus > 0, 8000, 100);
  hardAssert(actFired, "POST /act fired from sandboxed iframe within 8s");
  hardAssert(actResponseStatus === 200, `POST /act returned 200 (got ${actResponseStatus})`);
  hardAssert(actResponseBody.includes("working"), `ack fragment response body contains "working"`);
  hardAssert(!actResponseBody.includes("<html"), `ack fragment is a FRAGMENT (no <html>)`);

  await page.screenshot({ path: `${EVIDENCE}/e2e-stage3-ack-fragment.png` });
  console.log("Screenshot: e2e-stage3-ack-fragment.png");

  // --- Stage 3: Verify daemon state — body.html advanced to workingPage ---
  console.log("\n=== Stage 3: Verify body.html advanced ===");
  const bodyMtimeAdvanced = await pollUntil(() => {
    try { return statSync(join(sessDir, "body.html")).mtimeMs > bodyMtimeBefore; }
    catch { return false; }
  }, 5000, 100);

  hardAssert(bodyMtimeAdvanced, "body.html mtime advanced after POST /act (workingPage written)");

  const bodyContent = readFileSync(join(sessDir, "body.html"), "utf8");
  assert(bodyContent.includes("working"), "body.html contains workingPage ('working') sentinel");

  // last-activity.txt must have been written
  assert(existsSync(join(sessDir, "last-activity.txt")), "last-activity.txt written by /act");

  // --- Stage 4: Simulate agent — write fresh body.html → SSE reload swaps iframe ---
  console.log("\n=== Stage 4: Simulate agent response → SSE reload ===");
  const AGENT_BODY = `<!doctype html>
<html><head><title>chosen</title></head><body>
<p id="result">chosen: ship</p>
<form hx-post="/s/{{VOS_UUID}}/act" hx-target="#status" hx-swap="innerHTML">
  <button name="choice" value="ship">Ship again</button>
</form>
<div id="status"></div>
</body></html>`;

  // Write the agent's new body.html (simulates the LLM having written a response)
  writeFileSync(join(sessDir, "body.html"), AGENT_BODY);
  console.log("Agent body.html written");

  // Wait for SSE reload to swap the iframe content (SSE polls every 1s)
  const sseReloaded = await pollUntil(async () => {
    try {
      const resultEl = frame.locator("#result");
      const text = await resultEl.innerText({ timeout: 1500 });
      return text.includes("chosen: ship");
    } catch { return false; }
  }, 10000, 300);

  assert(sseReloaded, `SSE reload swapped iframe to agent's new body.html (shows "chosen: ship")`);

  await page.screenshot({ path: `${EVIDENCE}/e2e-stage4-sse-reloaded.png` });
  console.log("Screenshot: e2e-stage4-sse-reloaded.png");

  // Verify the form is still wired after SSE reload (loop continues, {{VOS_UUID}} substituted)
  if (sseReloaded) {
    const newFormVisible = await pollUntil(async () => {
      try {
        await frame.locator("form").waitFor({ state: "visible", timeout: 1500 });
        const newFormHtml = await frame.locator("form").innerHTML({ timeout: 1500 });
        return !newFormHtml.includes("{{VOS_UUID}}");
      } catch { return false; }
    }, 5000, 300);
    assert(newFormVisible, "new body.html form visible with UUID substituted (loop continues)");
  }

  console.log("\n=== ALL E2E assertions complete ===");
  console.log(`Evidence screenshots written to: ${EVIDENCE}`);

} catch (err) {
  console.error("E2E ERROR:", err);
  await page.screenshot({ path: `${EVIDENCE}/e2e-error.png` }).catch(() => {});
  exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  process.exit(exitCode);
}
