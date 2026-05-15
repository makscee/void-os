import { test, expect, chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DEFAULT_PING_MS } from "../../src/config.ts";

test("plugin boots and reaches connected state, sustained across one heartbeat", async () => {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath) throw new Error("VOS_E2E_STATE not set — globalSetup did not run");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    port: number;
    cdpPort: number;
    vaultPath: string;
    obsidianUserDataDir: string;
  };

  // Connect to the already-running Obsidian via CDP (launched by globalSetup).
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`);

  try {
    // Wait for the vault page (index.html) to appear.
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

    // Obsidian shows a "Do you trust the author of this vault?" modal on first
    // open in a fresh user-data-dir.  Dismiss it so plugins can load.
    await vaultPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll(".modal-container button"))
        .find((b) => b.textContent?.includes("Trust"));
      if (btn) (btn as HTMLElement).click();
    });

    // Now wait for the void-os status bar element (plugin loads after trust).
    const pill = vaultPage.getByTestId("vos-status-bar");
    await expect(pill).toHaveText("void-os: connected", { timeout: 20_000 });
    await vaultPage.waitForTimeout(DEFAULT_PING_MS + 2_000);
    await expect(pill).toHaveText("void-os: connected");
  } finally {
    await browser.close();
  }
});
