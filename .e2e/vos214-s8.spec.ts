// VOS-214 Phase P2 — S8 no-html / wedged-case iframe-gate fixture spec.
//
// Coverage: S8·t1–t4 (fixture, no live processes).
//
// Session matrix (seeded by vos214-s8-serve.ts):
//   NO_BODY     — no body.html written at all (the wedged empty session)
//   PLACEHOLDER — body.html == placeholderBody ("— starting…" spinner)
//   REAL_BODY   — body.html with real agent content
//
// Core assertions:
//   t1: no-body session → 200, NO <iframe#f>, /body → 404
//   t2: no-body session → msg-input + Send + #attachForm ALWAYS present (VOS-210 ungating)
//   t3: placeholder body → still NO <iframe#f> (iff-gate holds: bodyHasRealContent==false)
//   t4: real body → <iframe#f> present, correct src, real <h1> accessible inside frame
//
// Anti-tautology:
//   Each negative iframe assertion is proven falsifiable — see handoff for the broken-fixture proof.
import { test, expect, request } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.VOS214_S8_BASE_URL!;
const TRUTH_OUT = process.env.VOS214_S8_TRUTH_OUT!;
const SHOT_DIR = process.env.VOS214_S8_SHOT_DIR!;

const NO_BODY = "s8-no-body-0000-0000-0000-000000000000";
const PLACEHOLDER = "s8-placeholder-0000-0000-0000-00000000";
const REAL_BODY = "s8-real-body-0000-0000-0000-000000000";

const truth: Record<string, unknown> = {};

test.afterAll(() => {
  writeFileSync(TRUTH_OUT, JSON.stringify(truth, null, 2));
});

// ──────────────────────────────────────────────────────────────────────────────
// S8·t1 — no-body session: 200 shell, NO iframe#f, /body → 404
// ──────────────────────────────────────────────────────────────────────────────
test("S8·t1: no-body session — 200 shell, no iframe#f, /body 404", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // Shell renders 200
  const resp = await page.goto(`${BASE}/s/${NO_BODY}`, { waitUntil: "domcontentloaded" });
  expect(resp?.status(), "shell must return 200").toBe(200);

  // Core: NO iframe#f rendered (bodyHasRealContent==false when no body.html)
  await expect(page.locator("iframe#f"), "no-body session must NOT render iframe#f").toHaveCount(0);

  // Confirm no iframe at all (belt-and-suspenders)
  const anyIframe = await page.locator("iframe").count();
  truth["t1_iframeCount"] = anyIframe;
  expect(anyIframe, "no-body session must have zero iframes").toBe(0);

  // /body must return 404 (no spinner wedged inside shell via /body)
  const apiCtx = await request.newContext();
  const bodyResp = await apiCtx.get(`${BASE}/s/${NO_BODY}/body`);
  truth["t1_bodyStatus"] = bodyResp.status();
  expect(bodyResp.status(), "/body endpoint must 404 when no body.html exists").toBe(404);
  await apiCtx.dispose();

  expect(pageErrors, `page must not throw with iframe absent: ${pageErrors.join("; ")}`).toHaveLength(0);

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, "t1-no-body.png"), fullPage: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// S8·t2 — no-body session: chat affordances ALWAYS present (VOS-210 ungating)
// ──────────────────────────────────────────────────────────────────────────────
test("S8·t2: no-body session — msg-input + Send + attach present unconditionally", async ({ page }) => {
  await page.goto(`${BASE}/s/${NO_BODY}`, { waitUntil: "domcontentloaded" });

  // The three affordances that must render regardless of body state (VOS-210 ungating)
  const msgInput = page.locator('#msgForm input[name="text"].msg-input');
  const sendBtn = page.locator("#msgForm button.msg-send");
  const attachForm = page.locator("#attachForm");

  await expect(msgInput, "msg-input must be visible on no-body session").toBeVisible();
  await expect(sendBtn, "Send button must be visible on no-body session").toBeVisible();
  await expect(attachForm, "#attachForm must be present on no-body session").toBeVisible();

  // Verify non-zero bounding boxes (not hidden via visibility:hidden or zero-size)
  const inputBox = await msgInput.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  const sendBox = await sendBtn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  expect(inputBox.w, "msg-input must have non-zero width").toBeGreaterThan(0);
  expect(inputBox.h, "msg-input must have non-zero height").toBeGreaterThan(0);
  expect(sendBox.w, "Send button must have non-zero width").toBeGreaterThan(0);
  expect(sendBox.h, "Send button must have non-zero height").toBeGreaterThan(0);

  truth["t2_inputBox"] = inputBox;
  truth["t2_sendBox"] = sendBox;
  truth["t2_affordancesPresent"] = true;

  // No spinner should overlay the chat view
  const spinnerCount = await page.locator(".spinner").count();
  truth["t2_spinnerCountInShell"] = spinnerCount;
  expect(spinnerCount, "no .spinner element should be visible in shell over no-body session").toBe(0);

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, "t2-affordances.png"), fullPage: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// S8·t3 — placeholder body: iff-gate holds, NO <iframe#f> in shell
//          (bodyHasRealContent==false for spinner + "— starting…" title)
// ──────────────────────────────────────────────────────────────────────────────
test("S8·t3: placeholder body — iff-gate holds, no iframe#f in shell", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/s/${PLACEHOLDER}`, { waitUntil: "domcontentloaded" });

  // Core assertion: placeholder body must NOT trigger iframe mount in shell
  await expect(page.locator("iframe#f"), "placeholder body must NOT render iframe#f in shell").toHaveCount(0);

  const anyIframe = await page.locator("iframe").count();
  truth["t3_iframeCount"] = anyIframe;
  expect(anyIframe, "placeholder body must have zero iframes in shell").toBe(0);

  // Affordances still present (placeholder doesn't gate them out)
  await expect(page.locator('#msgForm input[name="text"].msg-input'), "msg-input present with placeholder body").toBeVisible();
  await expect(page.locator("#msgForm button.msg-send"), "Send present with placeholder body").toBeVisible();
  await expect(page.locator("#attachForm"), "attachForm present with placeholder body").toBeVisible();

  // No spinner in the SHELL itself (spinner lives only in /body, served inside iframe when real)
  // For placeholder: the shell must NOT mount the spinner over chat
  const shellSpinnerCount = await page.locator(".spinner").count();
  truth["t3_shellSpinnerCount"] = shellSpinnerCount;
  expect(shellSpinnerCount, "no .spinner in shell HTML when body is placeholder (spinner only in /body iframe)").toBe(0);

  expect(pageErrors, `no page errors for placeholder session: ${pageErrors.join("; ")}`).toHaveLength(0);

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, "t3-placeholder.png"), fullPage: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// S8·t4 — real body: iframe#f present, correct src, real <h1> accessible
// ──────────────────────────────────────────────────────────────────────────────
test("S8·t4: real body — iframe#f present with correct src and accessible h1", async ({ page }) => {
  await page.goto(`${BASE}/s/${REAL_BODY}`, { waitUntil: "domcontentloaded" });

  // Core: real content → iframe MUST be rendered
  const iframe = page.locator("iframe#f");
  await expect(iframe, "real-body session must render iframe#f").toHaveCount(1);
  await expect(iframe, "iframe#f must have correct src").toHaveAttribute("src", `/s/${REAL_BODY}/body`);

  // Real content accessible inside the frame
  const frameH1 = page.frameLocator("iframe#f").locator("h1");
  await expect(frameH1, "h1 inside iframe must contain real agent content").toHaveText("Agent Output");

  // Affordances STILL present even with iframe
  await expect(page.locator('#msgForm input[name="text"].msg-input'), "msg-input present with real body").toBeVisible();
  await expect(page.locator("#msgForm button.msg-send"), "Send present with real body").toBeVisible();
  await expect(page.locator("#attachForm"), "attachForm present with real body").toBeVisible();

  const iframeBox = await iframe.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  truth["t4_iframePresent"] = 1;
  truth["t4_iframeBox"] = iframeBox;
  expect(iframeBox.w, "iframe must have non-zero width").toBeGreaterThan(0);
  expect(iframeBox.h, "iframe must have non-zero height").toBeGreaterThan(0);

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, "t4-real.png"), fullPage: true });
});
