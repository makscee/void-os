import { test, expect, chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

// VOS-139: the plugin registers a ribbon icon (lucide "circle-dot",
// tooltip "void-os chat") that activates the chat view leaf. Assert:
//   1. the ribbon icon renders with aria-label "void-os chat" inside
//      Obsidian's side-dock ribbon (`.side-dock-ribbon-action`).
//   2. clicking it creates a workspace leaf of CHAT_VIEW_TYPE
//      ("void-os-chat", from plugin/src/view.ts).
test("ribbon icon opens chat view leaf", async () => {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath) throw new Error("VOS_E2E_STATE not set — globalSetup did not run");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    port: number;
    cdpPort: number;
    vaultPath: string;
    obsidianUserDataDir: string;
  };

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`);

  try {
    let vaultPage = browser.contexts().flatMap(ctx => ctx.pages())
      .find(p => p.url() === "app://obsidian.md/index.html");

    if (!vaultPage) {
      const ctx = browser.contexts()[0];
      vaultPage = await ctx.waitForEvent("page", {
        predicate: (p) => p.url() === "app://obsidian.md/index.html",
        timeout: 20_000,
      });
    }

    await vaultPage.waitForLoadState("domcontentloaded");

    // Dismiss "Trust author" modal if present (fresh user-data-dir path).
    const trustBtn = vaultPage.getByRole("button", { name: /Trust author/i });
    try {
      await trustBtn.click({ timeout: 10_000 });
    } catch {
      // Already trusted — proceed.
    }

    // Wait for the plugin to fully load (status pill = canonical signal).
    const pill = vaultPage.getByTestId("vos-status-bar");
    await expect(pill).toHaveText("void-os: connected", { timeout: 20_000 });

    // Assert ribbon icon presence + tooltip (aria-label IS the tooltip
    // text in Obsidian's ribbon DOM). Scope to .side-dock-ribbon-action
    // so an unrelated descendant in a settings modal can't satisfy this.
    const ribbon = vaultPage.locator(
      '.side-dock-ribbon-action[aria-label="void-os chat"]',
    );
    await expect(ribbon).toHaveCount(1, { timeout: 10_000 });
    await expect(ribbon).toBeVisible();
    await expect(ribbon).toHaveAttribute("aria-label", "void-os chat");

    // Sanity: no chat leaf exists before the click.
    const countChatLeaves = () => vaultPage!.evaluate(() => {
      // @ts-expect-error — Obsidian exposes `app` globally on renderer.
      const app = (globalThis as { app?: { workspace: { getLeavesOfType: (t: string) => unknown[] } } }).app;
      return app ? app.workspace.getLeavesOfType("void-os-chat").length : -1;
    });
    expect(await countChatLeaves()).toBe(0);

    // Trigger the click via the in-page DOM. Obsidian's ribbon items are
    // bare DIVs (not buttons); Playwright's default actionability check
    // stalls waiting for a button role + hit-testing inside the side dock.
    // An in-page click on the same element fires Obsidian's own delegated
    // handler the same way a user mouse click would.
    await vaultPage.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        '.side-dock-ribbon-action[aria-label="void-os chat"]',
      );
      if (!el) throw new Error("ribbon element disappeared between assert and click");
      el.click();
    });

    // A chat leaf should appear in the workspace shortly after the click.
    await expect.poll(countChatLeaves, { timeout: 10_000 }).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});
