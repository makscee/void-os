import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { getVaultPage } from "../helpers/vault-page.ts";
import {
  closeChatView,
  reopenChatView,
  isChatViewOpen,
} from "../helpers/view-lifecycle.ts";

/**
 * VOS-153 T1 — smoke spec for the view-lifecycle helpers.
 *
 * Locks the contract that two T9 consumer specs depend on:
 *   - reopenChatView() puts a chat leaf in the workspace AND waits for
 *     ChatRoot to mount.
 *   - closeChatView() removes every chat leaf.
 *   - isChatViewOpen() reports leaf-count correctly.
 *
 * Deviation from the plan's literal Step 2 spec: the plan assumed the
 * vault fixture has the chat view open at boot. It does not — boot
 * state is 0 chat leaves (verified in ribbon-open.spec.ts, which asserts
 * `countChatLeaves() === 0` before clicking the ribbon). The smoke
 * therefore drives the lifecycle from the real boot state: closed →
 * open → closed → open. All three helpers are still exercised.
 */
interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
}

test("view-lifecycle helpers close and reopen ChatView leaf cleanly", async () => {
  test.setTimeout(60_000);
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath) throw new Error("VOS_E2E_STATE not set — globalSetup did not run");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    // Wait for plugin to fully load (canonical signal used across the suite).
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // Dismiss any first-launch modals (Settings / Community-plugins).
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Boot state: no chat leaves.
    expect(await isChatViewOpen(page)).toBe(false);

    // reopenChatView() must transition closed → open and wait for the
    // ChatRoot React tree to mount.
    await reopenChatView(page);
    expect(await isChatViewOpen(page)).toBe(true);

    // closeChatView() must drain every chat leaf.
    await closeChatView(page);
    expect(await isChatViewOpen(page)).toBe(false);

    // Idempotency-ish: reopen again from a known-closed state.
    await reopenChatView(page);
    expect(await isChatViewOpen(page)).toBe(true);
  } finally {
    await browser.close();
  }
});
