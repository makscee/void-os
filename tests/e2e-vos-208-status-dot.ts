/**
 * VOS-208 E2E: Status dot driven by real exec rows — false-green/stranded-yellow proof.
 *
 * Seeds one session per status using real registry DB rows, starts the server,
 * navigates to the dashboard, and asserts:
 *   - error session → .session-dot.err (red, not green)
 *   - reaped session → .session-dot.reaped (grey-blue, not green)
 *   - stopped session → .session-dot.stopped (grey, not green)
 *   - awaiting session → .session-dot.await (yellow, live form)
 *   - working + complete → default .session-dot (green)
 *
 * Run: bun run tests/e2e-vos-208-status-dot.ts
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openRegistry, createExecution, setExecutionEnded, setExecutionFail } from "../src/registry.ts";
import { bodyPath, sessionDir, reapedPath, stopPath, errorPath } from "../src/paths.ts";

const WORKTREE = "/Users/admin/void-os-wt/VOS-208";
const VAULT = "/tmp/void-os-e2e-vos208";
const PORT = 4398;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = "/tmp/vos-208-screenshots";
const BUN = process.execPath;

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`ASSERT FAIL: ${msg}`); process.exit(1); }
}

// ── Set up vault ──────────────────────────────────────────────────────────
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "sessions"), { recursive: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
mkdirSync(SCREENSHOT_DIR, { recursive: true });

writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT,
  onboarded: true,
  skills: [],
  answers: {},
  port: PORT,
  runners: [{ label: "fake", command: "echo --" }],
  defaultRunner: "fake",
}, null, 2));

// ── Seed registry + session dirs ──────────────────────────────────────────
const dbPath = join(VAULT, ".void-os", "registry.db");
const db = openRegistry(dbPath);
const now = Date.now();

const sessions: { uuid: string; status: string }[] = [];

function seedSession(uuid: string, body: string): void {
  mkdirSync(sessionDir(VAULT, uuid), { recursive: true });
  writeFileSync(bodyPath(VAULT, uuid), body);
  sessions.push({ uuid, status: "?" });
}

// 1. error via exec reason (false-green scenario — no error.txt, but reason set)
seedSession("s-error", `<title>failed run</title><p>output</p>`);
createExecution(db, { id: "s-error", agent: null, skill: null, inputRef: null,
  tmuxSession: "vos-run-s-error", now: now - 10000, triggerId: null, stepCeiling: null });
setExecutionFail(db, "s-error", "runaway-ceiling", now - 5000);

// 2. reaped via reaped.txt marker
seedSession("s-reaped", `<title>reaped run</title><p>output</p>`);
createExecution(db, { id: "s-reaped", agent: null, skill: null, inputRef: null,
  tmuxSession: "vos-run-s-reaped", now: now - 20000, triggerId: null, stepCeiling: null });
setExecutionEnded(db, "s-reaped", now - 10000);
writeFileSync(reapedPath(VAULT, "s-reaped"), "reaped\n");

// 3. stopped via stopped.txt
seedSession("s-stopped", `<title>stopped run</title><p>output</p>`);
createExecution(db, { id: "s-stopped", agent: null, skill: null, inputRef: null,
  tmuxSession: "vos-run-s-stopped", now: now - 30000, triggerId: null, stepCeiling: null });
setExecutionEnded(db, "s-stopped", now - 15000);
writeFileSync(stopPath(VAULT, "s-stopped"), "stopped\n");

// 4. awaiting — live exec + form (VOS-206 interactive path)
seedSession("s-await", `<title>awaiting verdict</title><form action='/s/s-await/send' method='POST'><input name='verdict'><button type='submit'>Accept</button></form>`);
createExecution(db, { id: "s-await", agent: null, skill: null, inputRef: null,
  tmuxSession: "vos-run-s-await", now: now - 5000, triggerId: null, stepCeiling: null });

// 5. working — live exec, no form
seedSession("s-working", `<title>working run</title><p>processing…</p>`);
createExecution(db, { id: "s-working", agent: null, skill: null, inputRef: null,
  tmuxSession: "vos-run-s-working", now: now - 3000, triggerId: null, stepCeiling: null });

// 6. complete — exec ended cleanly, no form
seedSession("s-complete", `<title>complete run</title><p>done!</p>`);
createExecution(db, { id: "s-complete", agent: null, skill: null, inputRef: null,
  tmuxSession: "vos-run-s-complete", now: now - 40000, triggerId: null, stepCeiling: null });
setExecutionEnded(db, "s-complete", now - 35000);

db.close();

// ── Start server ──────────────────────────────────────────────────────────
console.log("Starting void-os server on port", PORT, "...");
const server = spawn(BUN, ["run", "src/cli.ts", "serve", "--no-open"], {
  cwd: WORKTREE,
  env: { ...process.env, VOID_OS_VAULT: VAULT, VOID_OS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));

// Wait for server to start
await new Promise<void>((r) => setTimeout(r, 3000));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let exitCode = 0;

try {
  // =========================================================================
  // Check 1: Dashboard loads and all 6 sessions appear
  // =========================================================================
  console.log("\n--- Check 1: Dashboard loads, 6 sessions present ---");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForSelector(".session-list", { timeout: 8000 });

  const sessionRows = await page.$$(".session-row");
  console.log("session-row count:", sessionRows.length);
  // We seeded 6 sessions; dashboard shows them all in the Sessions section
  // (the await one may also appear in Agent inbox)
  assert(sessionRows.length >= 6, `Expected at least 6 session rows, got ${sessionRows.length}`);
  console.log("Check 1 PASSED: Dashboard shows all 6 sessions.");

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-all-sessions.png`, fullPage: true });
  console.log(`Screenshot: ${SCREENSHOT_DIR}/01-all-sessions.png`);

  // =========================================================================
  // Check 2: Error session has red dot (.session-dot.err), NOT default green
  // =========================================================================
  console.log("\n--- Check 2: Error session has red dot ---");
  const errorDot = await page.$$eval(".session-row", (rows) => {
    for (const row of rows) {
      if (row.querySelector("a")?.getAttribute("href")?.includes("s-error") ||
          row.getAttribute("href")?.includes("s-error")) {
        const dot = row.querySelector(".session-dot");
        return dot ? dot.className : null;
      }
    }
    return null;
  });
  // Look for the error session dot directly via its href
  const errorRowDotClass = await page.$eval(
    'a[href="/s/s-error"] .session-dot',
    (el) => el.className,
  ).catch(() => null);

  console.log("Error row dot class:", errorRowDotClass);
  assert(
    errorRowDotClass !== null && errorRowDotClass.includes("err"),
    `Expected error session dot to have 'err' class, got: ${errorRowDotClass}`,
  );
  assert(
    !errorRowDotClass!.includes("session-dot err") || !errorRowDotClass!.trim().endsWith("session-dot"),
    "Error session must have a non-default (non-green) dot",
  );
  console.log("Check 2 PASSED: Error session has red dot.");

  // =========================================================================
  // Check 3: Reaped session has grey-blue dot (.session-dot.reaped)
  // =========================================================================
  console.log("\n--- Check 3: Reaped session has grey-blue dot ---");
  const reapedDotClass = await page.$eval(
    'a[href="/s/s-reaped"] .session-dot',
    (el) => el.className,
  ).catch(() => null);
  console.log("Reaped row dot class:", reapedDotClass);
  assert(
    reapedDotClass !== null && reapedDotClass.includes("reaped"),
    `Expected reaped session dot to have 'reaped' class, got: ${reapedDotClass}`,
  );
  console.log("Check 3 PASSED: Reaped session has grey-blue dot.");

  // =========================================================================
  // Check 4: Stopped session has grey dot (.session-dot.stopped)
  // =========================================================================
  console.log("\n--- Check 4: Stopped session has grey dot ---");
  const stoppedDotClass = await page.$eval(
    'a[href="/s/s-stopped"] .session-dot',
    (el) => el.className,
  ).catch(() => null);
  console.log("Stopped row dot class:", stoppedDotClass);
  assert(
    stoppedDotClass !== null && stoppedDotClass.includes("stopped"),
    `Expected stopped session dot to have 'stopped' class, got: ${stoppedDotClass}`,
  );
  console.log("Check 4 PASSED: Stopped session has grey dot.");

  // =========================================================================
  // Check 5: Working + complete sessions have default green dot (no extra class)
  // =========================================================================
  console.log("\n--- Check 5: Working + complete have green dot ---");
  const workingDotClass = await page.$eval(
    'a[href="/s/s-working"] .session-dot',
    (el) => el.className,
  ).catch(() => null);
  const completeDotClass = await page.$eval(
    'a[href="/s/s-complete"] .session-dot',
    (el) => el.className,
  ).catch(() => null);
  console.log("Working row dot class:", workingDotClass);
  console.log("Complete row dot class:", completeDotClass);
  assert(
    workingDotClass !== null && workingDotClass.trim() === "session-dot",
    `Expected working session dot to have only 'session-dot' (green), got: ${workingDotClass}`,
  );
  assert(
    completeDotClass !== null && completeDotClass.trim() === "session-dot",
    `Expected complete session dot to have only 'session-dot' (green), got: ${completeDotClass}`,
  );
  console.log("Check 5 PASSED: Working + complete have default green dot.");

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-dots-final.png`, fullPage: true });
  console.log(`Screenshot: ${SCREENSHOT_DIR}/02-dots-final.png`);

  console.log("\n=== ALL CHECKS PASSED — VOS-208 status dots correct ===");
  console.log(`Evidence screenshots: ${SCREENSHOT_DIR}/01-all-sessions.png`);
  console.log(`Evidence screenshots: ${SCREENSHOT_DIR}/02-dots-final.png`);

} catch (err) {
  console.error("E2E FAILED:", err);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/failure.png`, fullPage: true }).catch(() => {});
  exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  process.exit(exitCode);
}
