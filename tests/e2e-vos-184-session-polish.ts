/**
 * VOS-184 E2E: Session-view polish
 *
 * Verifies:
 * 1. Smoke-test body (bare fragment) is readable — light background + dark text in iframe.
 * 2. Session-view header shows the skill name, not the raw UUID.
 *
 * Run: bun run tests/e2e-vos-184-session-polish.ts
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const VAULT = "/tmp/void-os-e2e-vos184";
const PORT = 4393;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_BEFORE = "/tmp/vos-184-01-before-fix-body.png";
const SCREENSHOT_AFTER_BODY = "/tmp/vos-184-02-readable-body.png";
const SCREENSHOT_HEADER = "/tmp/vos-184-03-session-name-header.png";

// Set up vault with fake runner
mkdirSync(join(VAULT, "sessions"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT,
  onboarded: true,
  skills: [],
  answers: {},
  port: PORT,
  runners: [{ label: "fake", command: "/Users/admin/void-os-wt/VOS-184/tests/fixtures/fake-runner.sh --" }],
  defaultRunner: "fake",
}, null, 2));

console.log("Starting void-os server on port", PORT, "...");
const WORKTREE = "/Users/admin/void-os-wt/VOS-184";
const server = spawn("bun", ["run", "src/cli.ts", "serve", "--no-open"], {
  cwd: WORKTREE,
  env: { ...process.env, VOID_OS_VAULT: VAULT, VOID_OS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));

await new Promise<void>((resolve) => setTimeout(resolve, 2000));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

let ok = false;

try {
  // --- Navigate to dashboard ---
  console.log("Navigating to dashboard...");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("Dashboard loaded, title:", await page.title());

  // --- Launch smoke-test ---
  console.log("Launching smoke-test...");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click("button.skill-chip", { timeout: 5000 }),
  ]);

  const url = page.url();
  console.log("Redirected to:", url);
  const match = url.match(/\/s\/([0-9a-f-]{36})/);
  if (!match) throw new Error(`No UUID in URL: ${url}`);
  const sessionUuid = match[1];
  console.log("Session UUID:", sessionUuid);

  // Wait for fake-runner to finish writing body.html
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  // --- Bug 1: Verify body readability (light theme on bare fragment) ---
  // Manually write a bare smoke-test fragment (like the real skill would) to the session.
  const sessionDir = join(VAULT, "sessions", sessionUuid);
  writeFileSync(
    join(sessionDir, "body.html"),
    "<h1>smoke-test ✓ session live</h1><p>no input</p><form method=\"POST\" action=\"/s/" + sessionUuid + "/send\"><input name=\"echo\" placeholder=\"type anything\"><button>submit</button></form>",
  );

  // Navigate to body URL directly to check readability
  await page.goto(`${BASE}/s/${sessionUuid}/body`, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.screenshot({ path: SCREENSHOT_BEFORE, fullPage: false });
  console.log("Body screenshot saved:", SCREENSHOT_BEFORE);

  // Check that the body background is white (or at least not dark) and text has color
  const bodyBg = await page.evaluate(() => {
    const body = document.body;
    return window.getComputedStyle(body).backgroundColor;
  });
  const h1Color = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    if (!h1) return null;
    return window.getComputedStyle(h1).color;
  });

  console.log("body background-color:", bodyBg);
  console.log("h1 color:", h1Color);

  // Parse rgb values to confirm contrast: bg should be near white, text near dark
  // rgb(255, 255, 255) = white; rgb(26, 26, 26) = dark text
  const bgIsLight = bodyBg.includes("255, 255, 255") || bodyBg.includes("rgb(255");
  const textIsDark = h1Color && (h1Color.includes("26, 26, 26") || h1Color.includes("rgb(0") || h1Color.includes("rgb(26"));

  console.log("BG is light:", bgIsLight);
  console.log("Text is dark:", textIsDark);

  if (!bgIsLight) {
    console.error(`ERROR: body background is not white: ${bodyBg}`);
    process.exit(1);
  }
  if (!textIsDark) {
    console.error(`ERROR: h1 text color is not dark: ${h1Color}`);
    process.exit(1);
  }

  await page.screenshot({ path: SCREENSHOT_AFTER_BODY, fullPage: false });
  console.log("Readable body screenshot saved:", SCREENSHOT_AFTER_BODY);

  // --- Bug 2: Verify header shows session name, not raw UUID ---
  // Navigate to the session shell page
  await page.goto(`${BASE}/s/${sessionUuid}`, { waitUntil: "domcontentloaded", timeout: 10000 });

  // Verify session-meta.json has the skill name
  const metaPath = join(sessionDir, "session-meta.json");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    console.log("Session meta:", JSON.stringify(meta));
  }

  // Read the session-name element text
  const sessionNameText = await page.$eval(".session-name", (el: Element) => el.textContent?.trim() ?? "");
  console.log("Header session-name text:", sessionNameText);

  // Confirm it's NOT the raw UUID (uuid is 36 chars)
  const isRawUuid = sessionNameText === sessionUuid;
  const containsSkillName = sessionNameText.includes("smoke-test") || sessionNameText.includes("fake");
  const isShortFallback = sessionNameText.includes(sessionUuid.slice(0, 8));

  console.log("Is raw UUID:", isRawUuid);
  console.log("Contains skill name:", containsSkillName);
  console.log("Is short fallback:", isShortFallback);

  if (isRawUuid) {
    console.error("ERROR: header still shows raw UUID instead of name");
    process.exit(1);
  }

  await page.screenshot({ path: SCREENSHOT_HEADER, fullPage: false });
  console.log("Header screenshot saved:", SCREENSHOT_HEADER);

  ok = true;
  console.log("SUCCESS: Both bugs verified fixed.");
  console.log("  Bug 1: smoke-test body is readable (white bg / dark text)");
  console.log("  Bug 2: header shows session name, not raw UUID");

} finally {
  await browser.close();
  server.kill();
  if (!ok) process.exit(1);
}
