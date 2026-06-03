// VOS-214 Phase-3 Playwright spec — S5·t1–t4 attach/resume-command fixture steps.
// No bun-module imports: runs under node/Playwright's own runner.
// Server started externally; URL in VOS214_S5_BASE_URL.
import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE   = process.env.VOS214_S5_BASE_URL!;
const VAULT  = process.env.VOS214_S5_VAULT!;
const SHOT_DIR = process.env.VOS214_S5_SHOT_DIR!;
const TRUTH_OUT = process.env.VOS214_S5_TRUTH_OUT!;

// Session IDs — must match vos214-s5-serve.ts constants
const LIVE_ID   = "11111111-1111-4111-a111-111111111111";
const REAPED_ID = "22222222-2222-4222-a222-222222222222";
const EXITED_ID = "33333333-3333-4333-a333-333333333333";
const PRECID_ID = "44444444-4444-4444-a444-444444444444";
const CC_ID     = "abcdef01-2345-4678-89ab-cdef01234567";

interface Truth {
  t1: { live: string; reaped: string; exited: string };
  t2: { fetchIntercepted: boolean };
  t3: { resumeCmdCorrect: boolean; ccIdForm: boolean; noTmuxTarget: boolean; notRunId: boolean };
  t4: { dataCmdValue: string; misleadingResumeFinding?: string; verdict: string };
}

const truth: Truth = {
  t1: { live: "pending", reaped: "pending", exited: "pending" },
  t2: { fetchIntercepted: false },
  t3: { resumeCmdCorrect: false, ccIdForm: false, noTmuxTarget: false, notRunId: false },
  t4: { dataCmdValue: "", verdict: "pending" },
};

test.afterAll(() => {
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(TRUTH_OUT, JSON.stringify(truth, null, 2));
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function assertAttachAndCopybtn(page: import("@playwright/test").Page, uuid: string): Promise<void> {
  await page.goto(`${BASE}/s/${uuid}`, { waitUntil: "domcontentloaded" });
  // attach button always present (ungated per VOS-210)
  const attachBtn = page.locator("#attachForm button.attach-btn");
  await expect(attachBtn).toBeVisible({ timeout: 5000 });
  // copy-resume button always present
  const copybtn = page.locator("#copybtn[data-cmd]");
  await expect(copybtn).toBeVisible({ timeout: 5000 });
}

// ── S5·t1 ─────────────────────────────────────────────────────────────────────
// All 3 lifecycle states: attach button + copy-resume button ALWAYS present.
// REJECT if either is absent in any state.

test("S5·t1 — attach button + copybtn present in all lifecycle states (live/reaped/exited)", async ({ page }) => {
  // live
  await assertAttachAndCopybtn(page, LIVE_ID);
  await page.screenshot({ path: join(SHOT_DIR, "t1-live.png"), fullPage: true });
  truth.t1.live = "ACCEPT";

  // reaped
  await assertAttachAndCopybtn(page, REAPED_ID);
  await page.screenshot({ path: join(SHOT_DIR, "t1-reaped.png"), fullPage: true });
  truth.t1.reaped = "ACCEPT";

  // exited (no reaped.txt but no live tmux)
  await assertAttachAndCopybtn(page, EXITED_ID);
  await page.screenshot({ path: join(SHOT_DIR, "t1-exited.png"), fullPage: true });
  truth.t1.exited = "ACCEPT";
});

// ── S5·t2 ─────────────────────────────────────────────────────────────────────
// Attach form uses fetch() + preventDefault — submitting does NOT navigate to JSON {ok}.
// ACCEPT if fetch-intercepted. REJECT if native POST navigates to JSON body.

test("S5·t2 — #attachForm uses fetch() (no navigation to JSON response)", async ({ page }) => {
  await page.goto(`${BASE}/s/${LIVE_ID}`, { waitUntil: "domcontentloaded" });

  // Assert fetch + preventDefault in the shell HTML source
  const content = await page.content();
  const hasFetch = content.includes("fetch(");
  const hasPreventDefault = content.includes("preventDefault");
  expect(hasFetch, "shell HTML must contain fetch(").toBe(true);
  expect(hasPreventDefault, "shell HTML must contain preventDefault").toBe(true);

  // Also verify behaviourally: submit the form and assert URL stays on /s/<uuid>
  const urlBefore = page.url();
  // Submit the attach form; since the fetch intercept runs, URL must not change to a new page
  await page.locator("#attachForm button.attach-btn").click();
  // Give 1 second for any navigation (there should be none)
  await page.waitForTimeout(800);
  const urlAfter = page.url();
  // URL must still be /s/<uuid> (not a JSON body page, not /attach-here)
  expect(urlAfter).toContain(`/s/${LIVE_ID}`);

  await page.screenshot({ path: join(SHOT_DIR, "t2-attach-intercept.png"), fullPage: true });
  truth.t2.fetchIntercepted = true;
});

// ── S5·t3 ─────────────────────────────────────────────────────────────────────
// When ccId exists: #copybtn data-cmd == "cd <vault> && vc -- --resume <CC_ID>".
// Asserts: ccId-form, no tmux target, not the runId.
// ACCEPT if ccId-form + dead-tmux-target absent + not-runId. REJECT otherwise.

test("S5·t3 — copybtn data-cmd is ccId-form resume command (not tmux / not runId)", async ({ page }) => {
  await page.goto(`${BASE}/s/${LIVE_ID}`, { waitUntil: "domcontentloaded" });

  const copybtn = page.locator("#copybtn");
  await expect(copybtn).toBeVisible({ timeout: 5000 });

  const dataCmd = await copybtn.getAttribute("data-cmd");
  expect(dataCmd, "data-cmd must not be null").toBeTruthy();

  // Must be the ccId-form command
  const expectedCmd = `cd ${VAULT} && vc -- --resume ${CC_ID}`;
  expect(dataCmd).toBe(expectedCmd);

  // Must NOT contain tmux attach target
  expect(dataCmd).not.toContain("tmux -L vos attach -t");

  // Must NOT be the runId (uuid of the session itself)
  expect(dataCmd).not.toContain(`--resume ${LIVE_ID}`);

  await page.screenshot({ path: join(SHOT_DIR, "t3-resume-cmd.png"), fullPage: true });
  truth.t3.resumeCmdCorrect = true;
  truth.t3.ccIdForm = true;
  truth.t3.noTmuxTarget = true;
  truth.t3.notRunId = true;
});

// ── S5·t4 ─────────────────────────────────────────────────────────────────────
// VOS-215 BUG C FIXED: pre-ccId state renders a suppressed <span> (no data-cmd),
// not a `--resume <runId>` button. renderShell now checks hasCcId = resumeCmd != null:
//   • hasCcId true  → <button class="copy-btn" id="copybtn" data-cmd="...">
//   • hasCcId false → <span class="copy-btn" id="copybtn" style="cursor:default;opacity:.5">starting…</span>
// Regression guard: assert the bug is ABSENT (no misleading --resume <runId> button).

test("S5·t4 — pre-ccId suppressed copybtn: no data-cmd, shows starting… (VOS-215 BUG C regression guard)", async ({ page }) => {
  await page.goto(`${BASE}/s/${PRECID_ID}`, { waitUntil: "domcontentloaded" });

  // The #copybtn element MUST be present (the span is always rendered)
  const copybtn = page.locator("#copybtn");
  await expect(copybtn).toBeVisible({ timeout: 5000 });

  // VOS-215 FIX: pre-ccId copybtn MUST NOT have a data-cmd attribute.
  // (The old bug: it had data-cmd="cd <vault> && vc -- --resume <runId>")
  // Regression guard: if renderShell ever reverts to emitting the runId button,
  // data-cmd will be non-null and this assertion will FAIL.
  const dataCmd = await copybtn.getAttribute("data-cmd");
  expect(dataCmd, "pre-ccId #copybtn must NOT have data-cmd (no misleading --resume runId)").toBeNull();

  // The button text must say "starting…" (the suppressed placeholder)
  const btnText = (await copybtn.innerText()).toLowerCase();
  expect(btnText, "pre-ccId copybtn must display 'starting…' label").toContain("starting");

  // Must NOT contain --resume <runId> anywhere in the element's outer HTML
  const outerHtml = await copybtn.evaluate((el: Element) => el.outerHTML);
  expect(outerHtml, "pre-ccId copybtn outer HTML must NOT contain --resume <runId>")
    .not.toContain(`--resume ${PRECID_ID}`);

  await page.screenshot({ path: join(SHOT_DIR, "t4-pre-ccid.png"), fullPage: true });

  // Record passing verdict
  truth.t4.dataCmdValue = "(suppressed — no data-cmd attribute)";
  truth.t4.verdict = "ACCEPT: pre-ccId copybtn correctly suppressed (starting… span, no runId --resume). VOS-215 BUG C fixed.";

  // Log for CI output
  console.log(`S5·t4 verdict: ${truth.t4.verdict}`);
  console.log(`S5·t4 outerHTML: ${outerHtml}`);
});
