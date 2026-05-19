// VOS-151 E2E: clicking an agent row or a chat row focuses the composer
// textarea immediately, with no extra mouse step.
//
// Acceptance bullets covered:
//   1. Click agent row → composer is focused.
//   2. Click chat row → composer is focused.
//   3. Keyboard Enter on a focused chat row → composer is focused.
//   4. No modal/popover steal: implicitly covered — no modal is open when
//      we click, and `focusComposerInputSafely` skips when one is. The
//      `preventScroll: true` option is unit-tested in the helper spec.
//
// Drives the daemon via REST to seed a maya chat with a real run, so the
// ChatList isEmpty filter (see plugin/e2e/README.md) does NOT hide the
// row when we go to click it. Sibling pattern: chat-list-polish.spec.ts.
//
// Sibling smoke confirmed before write: agents-list-rail.spec.ts passes
// against this harness (43.5s).

import { test, expect, request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { getVaultPage } from "../helpers/vault-page.ts";
import { mintChat, sendMessage } from "../helpers/daemon-api.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
}

test("focus-on-selection: clicking agent row + chat row focuses the composer textarea", async () => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    // Precondition: plugin connected to daemon.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // Open chat view.
    await page.evaluate(() => {
      // @ts-ignore — Obsidian renderer global.
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    const chatRoot = page.getByTestId("vos-chat-root");
    await expect(chatRoot).toBeVisible({ timeout: 10_000 });

    // Dismiss first-launch modals. Critical — focus-composer.ts has a
    // `.modal-container` guard that skips focus when one is open.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-container")).toHaveCount(0, { timeout: 5_000 });

    // Seed a chat with a real text turn so it survives ChatList's isEmpty
    // filter. Fixture script (maya.jsonl) emits an assistant "hello from
    // fake" reply on first dispatch.
    const api = await request.newContext({
      baseURL: `http://127.0.0.1:${state.port}`,
    });
    try {
      const { chatId } = await mintChat(api, "maya");
      await sendMessage(api, chatId, "ping");

      // ChatList row should appear once the run lands.
      const chatRow = page.locator(`[data-testid='chat-row'][data-chat-id='${chatId}']`);
      await expect(chatRow).toBeVisible({ timeout: 30_000 });

      // The composer textarea (ComposerPrimitive.Input, placeholder="Message").
      const composer = chatRoot.getByPlaceholder("Message");
      await expect(composer).toBeVisible({ timeout: 5_000 });

      // --- Bullet 1: clicking an agent row focuses the composer ---------
      //
      // Move focus AWAY from the composer first; otherwise an
      // activeElement assertion is trivially true. Click the chat title
      // bar (non-interactive) via JS to blur.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      await expect.poll(async () => page.evaluate(() => document.activeElement?.tagName ?? ""))
        .not.toBe("TEXTAREA");

      // Click the journaler agent row — mints a new chat with that agent
      // and (VOS-151) focuses the composer.
      const journalerRow = page.locator("[data-testid='agent-row'][data-agent-name='journaler']");
      await expect(journalerRow).toBeVisible({ timeout: 5_000 });
      await journalerRow.click({ force: true, timeout: 5_000 });

      await expect.poll(
        async () => page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return {
            tag: el?.tagName ?? "",
            placeholder: el?.getAttribute("placeholder") ?? "",
          };
        }),
        { timeout: 5_000, intervals: [50, 100, 200] },
      ).toEqual({ tag: "TEXTAREA", placeholder: "Message" });

      // --- Bullet 2: clicking a chat row focuses the composer -----------
      //
      // Blur, click the seed chat-row, assert composer is focused.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      await expect.poll(async () => page.evaluate(() => document.activeElement?.tagName ?? ""))
        .not.toBe("TEXTAREA");

      await chatRow.click({ force: true, timeout: 5_000 });

      await expect.poll(
        async () => page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return {
            tag: el?.tagName ?? "",
            placeholder: el?.getAttribute("placeholder") ?? "",
          };
        }),
        { timeout: 5_000, intervals: [50, 100, 200] },
      ).toEqual({ tag: "TEXTAREA", placeholder: "Message" });

      // --- Bullet 3: keyboard activation (Enter) focuses the composer ---
      //
      // ChatList rows are native <button> elements, so Enter fires the
      // same onClick path as a mouse click. Tab to the row and press
      // Enter.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      await chatRow.focus();
      await page.keyboard.press("Enter");

      await expect.poll(
        async () => page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return {
            tag: el?.tagName ?? "",
            placeholder: el?.getAttribute("placeholder") ?? "",
          };
        }),
        { timeout: 5_000, intervals: [50, 100, 200] },
      ).toEqual({ tag: "TEXTAREA", placeholder: "Message" });
    } finally {
      await api.dispose();
    }
  } finally {
    await browser.close();
  }
});
