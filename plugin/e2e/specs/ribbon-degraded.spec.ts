import { test, expect, chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

// VOS-150: with voidOsBinaryPath seeded to a nonexistent path, ensureDaemon
// throws BinaryNotFoundError. Plugin must still register the ribbon icon, in
// its degraded variant. Clicking the icon must open the help modal.
test("degraded boot — ribbon shows alert + click opens help modal", async () => {
  const statePath = process.env.VOS_E2E_STATE_BINARY_MISSING;
  if (!statePath) {
    throw new Error("VOS_E2E_STATE_BINARY_MISSING not set — binary-missing globalSetup did not run");
  }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    cdpPort: number;
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

    const trustBtn = vaultPage.getByRole("button", { name: /Trust author/i });
    try { await trustBtn.click({ timeout: 10_000 }); } catch { /* already trusted */ }

    // Status bar pill is the canonical "plugin loaded" signal. In degraded
    // mode it carries the state-specific text.
    const pill = vaultPage.getByTestId("vos-status-bar");
    await expect(pill).toHaveText("void-os: binary-missing", { timeout: 20_000 });

    // Ribbon icon present with degraded tooltip.
    const ribbon = vaultPage.locator(
      '.side-dock-ribbon-action[aria-label="void-os degraded — binary not found"]',
    );
    await expect(ribbon).toHaveCount(1, { timeout: 10_000 });
    await expect(ribbon).toBeVisible();

    // Click → modal opens with the data-testid we attached.
    // Ribbon items are bare <div>s; locator.click() hangs on actionability —
    // dispatch the native click in-page per the E2E gotchas in CLAUDE.md.
    await vaultPage.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        '.side-dock-ribbon-action[aria-label="void-os degraded — binary not found"]',
      );
      if (!el) throw new Error("ribbon disappeared between assert and click");
      el.click();
    });

    const modal = vaultPage.locator('[data-testid="vos-degraded-modal"]');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal).toContainText("Daemon binary not found");
    await expect(modal.getByRole("button", { name: "Open settings" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Retry daemon" })).toBeVisible();
  } finally {
    await browser.close();
  }
});
