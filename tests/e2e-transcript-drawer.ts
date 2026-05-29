/**
 * VOS-183 E2E: Live transcript drawer
 *
 * Starts void-os serve with a fake-runner vault, launches smoke-test,
 * seeds the CC JSONL transcript for the session uuid, opens the drawer,
 * and screenshots the visible transcript content.
 *
 * Run: bun run tests/e2e-transcript-drawer.ts
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const VAULT = "/tmp/void-os-e2e-tx";
const PORT = 4391;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_OUT = "/tmp/vos-183-transcript-drawer.png";

// Ensure vault exists and is configured with fake runner
if (!existsSync(VAULT)) {
  mkdirSync(join(VAULT, "sessions"), { recursive: true });
}
mkdirSync(join(VAULT, "sessions"), { recursive: true });

writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT,
  onboarded: true,
  skills: [],
  answers: {},
  port: PORT,
  runners: [{ label: "fake", command: "/Users/admin/hub/workspace/void-os/tests/fixtures/fake-runner.sh --" }],
  defaultRunner: "fake",
}, null, 2));

// Start the void-os server
console.log("Starting void-os server on port", PORT, "...");
const server = spawn("bun", ["run", "src/cli.ts", "serve", "--no-open"], {
  cwd: "/Users/admin/hub/workspace/void-os",
  env: { ...process.env, VOID_OS_VAULT: VAULT, VOID_OS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));

// Wait for server to start
await new Promise<void>((resolve) => setTimeout(resolve, 2000));

let sessionUuid = "";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  // Navigate to dashboard
  console.log("Navigating to dashboard...");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded, title:", await page.title());

  // Launch smoke-test skill
  console.log("Launching smoke-test...");
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click('button.skill-chip', { timeout: 5000 }),
  ]);

  // Get the session UUID from the URL
  const url = page.url();
  console.log("Redirected to:", url);
  const match = url.match(/\/s\/([0-9a-f-]{36})/);
  if (!match) throw new Error(`No UUID in URL: ${url}`);
  sessionUuid = match[1];
  console.log("Session UUID:", sessionUuid);

  // Wait a moment for the fake runner to complete
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  // Seed the CC JSONL transcript for this session UUID
  const projectsDir = join(homedir(), ".claude", "projects", "-tmp-void-os-e2e-tx");
  mkdirSync(projectsDir, { recursive: true });
  const txPath = join(projectsDir, `${sessionUuid}.jsonl`);
  writeFileSync(txPath, [
    JSON.stringify({ type: "user", message: { role: "user", content: "/smoke-test transcript drawer test" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Starting smoke-test. Writing body.html..." }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done. Session complete." }] } }),
  ].join("\n") + "\n");
  console.log("Seeded transcript at:", txPath);

  // Reload the session page (it shows the body iframe)
  await page.reload({ waitUntil: "domcontentloaded" });

  // Wait for drawer bar to appear
  await page.waitForSelector("#drawer-bar", { timeout: 5000 });
  console.log("Drawer bar found.");

  // Click the drawer to open it
  await page.click("#drawer-bar");
  console.log("Clicked drawer bar.");

  // Wait for drawer to open and transcript to load
  await page.waitForFunction(() => document.body.classList.contains("drawer-open"), { timeout: 5000 });
  await new Promise<void>((resolve) => setTimeout(resolve, 2500)); // wait for poll

  // Check drawer content
  const panelHtml = await page.$eval("#drawer-panel", (el: Element) => el.innerHTML);
  console.log("Drawer panel HTML snippet:", panelHtml.slice(0, 300));

  // Screenshot
  await page.screenshot({ path: SCREENSHOT_OUT, fullPage: false });
  console.log("Screenshot saved to:", SCREENSHOT_OUT);

  // Verify transcript content is visible
  const hasTranscript = panelHtml.includes("/smoke-test") || panelHtml.includes("smoke-test");
  const hasClaude = panelHtml.includes("claude:");
  console.log("Has transcript user turn:", hasTranscript);
  console.log("Has claude turn:", hasClaude);

  if (!hasTranscript || !hasClaude) {
    console.error("ERROR: Transcript drawer not showing expected content");
    process.exit(1);
  }

  console.log("SUCCESS: Transcript drawer shows live transcript content.");

} finally {
  await browser.close();
  server.kill();
}
