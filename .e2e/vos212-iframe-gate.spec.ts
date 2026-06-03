// VOS-212 finalizer Playwright gate — render-only, real Chromium against bun-served makeApp
// (started by vos212-serve.ts, which reuses the VOS-210 seeded vault: a placeholder/no-real-content
// session + a real-body session). No bun-module imports here so it runs under node.
//
// The CORE assertion VOS-210 lacked: iframe ABSENCE when the body is placeholder/no-real-content.
// Asserts:
//   (a) placeholder session => NO <iframe> in the rendered shell; chat-first affordances ARE the view
//   (b) real-content session => <iframe id="f"> present AND serves the real body
//   (c) message input + Send + attach render UNCONDITIONALLY in BOTH states (VOS-210 not regressed)
//   (d) SSE reload no-ops gracefully when iframe absent (page does not throw on the missing #f)
import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.VOS212_BASE_URL!;
const TRUTH_OUT = process.env.VOS212_TRUTH_OUT!;
const NO_BODY = "no-body-sess-0000";
const REAL_BODY = "real-body-sess-1111";

const truth: Record<string, unknown> = {};

test.afterAll(() => {
  writeFileSync(TRUTH_OUT, JSON.stringify(truth, null, 2));
});

test("placeholder session: NO iframe, chat-first affordances ARE the view", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/s/${NO_BODY}`, { waitUntil: "domcontentloaded" });

  // (a) CORE: no iframe rendered for placeholder/no-real-content
  await expect(page.locator("iframe#f")).toHaveCount(0);
  const iframeCount = await page.locator("iframe").count();

  // (c) chat-first affordances render unconditionally
  const attachBtn = page.locator("#attachForm button.attach-btn");
  const msgInput = page.locator('#msgForm input[name="text"]');
  const sendBtn = page.locator("#msgForm button.msg-send");
  await expect(attachBtn).toBeVisible();
  await expect(msgInput).toBeVisible();
  await expect(sendBtn).toBeVisible();

  // rendered truth: affordances visible, non-zero bbox, send button has a real computed color
  const a = await attachBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { attachW: Math.round(r.width), attachH: Math.round(r.height), attachDisplay: cs.display };
  });
  const s = await sendBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { sendW: Math.round(r.width), sendH: Math.round(r.height), sendColor: cs.color, sendVisibility: cs.visibility };
  });
  // rendered-check contract: top-level `computed` must have non-zero / non-transparent props.
  // These are the affordances that MUST stay visible when the iframe is absent.
  truth["computed"] = {
    attachWidth: a.attachW,
    attachHeight: a.attachH,
    sendWidth: s.sendW,
    sendHeight: s.sendH,
    sendColor: s.sendColor,
  };
  truth["placeholderIframeCount"] = iframeCount;

  // (d) SSE null-guard: typing still works (page didn't throw on missing #f during onmessage wiring)
  const before = await msgInput.inputValue();
  await msgInput.fill("hello from VOS-212 finalizer");
  const after = await msgInput.inputValue();
  // rendered-check contract: top-level `interactions` array with a real before!=after state change.
  truth["interactions"] = [{ action: "type-message", before, after }];

  expect(pageErrors, `no page errors with iframe absent: ${pageErrors.join("; ")}`).toHaveLength(0);

  await page.screenshot({ path: join(process.env.VOS212_SHOT_DIR!, "vos212-no-iframe.png"), fullPage: true });
});

test("real-content session: iframe present, serves real body, chat affordances below", async ({ page }) => {
  await page.goto(`${BASE}/s/${REAL_BODY}`, { waitUntil: "domcontentloaded" });

  // (b) iframe present AND serves real content
  const iframe = page.locator("iframe#f");
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toHaveAttribute("src", `/s/${REAL_BODY}/body`);
  await expect(page.frameLocator("iframe#f").locator("h1")).toHaveText("Deep Research Results");

  // (c) chat affordances still render unconditionally
  await expect(page.locator("#attachForm button.attach-btn")).toBeVisible();
  await expect(page.locator('#msgForm input[name="text"]')).toBeVisible();
  await expect(page.locator("#msgForm button.msg-send")).toBeVisible();

  const ib = await iframe.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { iframeW: Math.round(r.width), iframeH: Math.round(r.height) };
  });
  // fold the iframe bbox into the rendered-check `computed` proof (non-zero size proves it rendered)
  truth["computed"] = { ...(truth["computed"] as object), iframeWidth: ib.iframeW, iframeHeight: ib.iframeH };
  truth["realIframePresent"] = 1;

  await page.screenshot({ path: join(process.env.VOS212_SHOT_DIR!, "vos212-iframe-present.png"), fullPage: true });
});
