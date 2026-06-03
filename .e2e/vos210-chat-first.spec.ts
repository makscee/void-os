// VOS-210 finalizer Playwright gate — render-only. Drives a real Chromium browser against a
// bun-served makeApp (started by vos210-serve.ts). No bun-module imports here, so it runs under node.
//
// Asserts:
//  (a) attach-here control renders UNCONDITIONALLY (placeholder + real-body sessions)
//  (b) message input + Send render
//  (c) iframe behavior: real-body session serves real content; placeholder/real both keep chat below
//  (d) copy-resume command is ccId-form `vc -- --resume <ccId>`, never a tmux target
import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.VOS210_BASE_URL!;
const NO_BODY = "no-body-sess-0000";
const REAL_BODY = "real-body-sess-1111";
const CC_ID = "abcdef01-2345-4678-89ab-cdef01234567";

const truth: Record<string, unknown> = {};

test.afterAll(() => {
  writeFileSync(join(tmpdir(), "vos210-render-truth.json"), JSON.stringify(truth, null, 2));
});

test("no-body session: chat + attach render unconditionally, resume is ccId-form", async ({ page }) => {
  await page.goto(`${BASE}/s/${NO_BODY}`, { waitUntil: "domcontentloaded" });

  // (a) attach-here renders unconditionally
  const attachBtn = page.locator("#attachForm button.attach-btn");
  await expect(attachBtn).toBeVisible();
  // (b) message input + Send render
  const msgInput = page.locator('#msgForm input[name="text"]');
  await expect(msgInput).toBeVisible();
  await expect(page.locator("#msgForm button.msg-send")).toBeVisible();
  // (d) copy-resume command is ccId-form, never tmux target
  const copyCmd = await page.locator("#copybtn").getAttribute("data-cmd");
  expect(copyCmd).toContain(`vc -- --resume ${CC_ID}`);
  expect(copyCmd).not.toContain("tmux -L vos attach");

  // rendered truth: attach button + msg input must be visible, non-zero, non-transparent
  const c = await attachBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { color: cs.color, attachWidth: Math.round(r.width), attachHeight: Math.round(r.height) };
  });
  const m = await msgInput.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { msgInputWidth: Math.round(r.width), msgInputHeight: Math.round(r.height) };
  });
  truth["computed"] = { ...c, ...m };

  // interaction proof: typing into the input changes its value (input wired, not a dead element)
  const before = await msgInput.inputValue();
  await msgInput.fill("hello from finalizer");
  const after = await msgInput.inputValue();
  truth["interactions"] = [{ action: "type-message", before, after }];

  await page.screenshot({ path: join(tmpdir(), "vos210-no-body.png"), fullPage: true });
});

test("real-body session: iframe serves real content AND chat affordances appear below", async ({ page }) => {
  await page.goto(`${BASE}/s/${REAL_BODY}`, { waitUntil: "domcontentloaded" });
  // precedence: show both — chat affordances present
  await expect(page.locator("#attachForm button.attach-btn")).toBeVisible();
  await expect(page.locator('#msgForm input[name="text"]')).toBeVisible();
  // iframe serves the real body
  const iframe = page.locator("iframe#f");
  await expect(iframe).toHaveAttribute("src", `/s/${REAL_BODY}/body`);
  await expect(page.frameLocator("iframe#f").locator("h1")).toHaveText("Deep Research Results");

  await page.screenshot({ path: join(tmpdir(), "vos210-real-body.png"), fullPage: true });
});
