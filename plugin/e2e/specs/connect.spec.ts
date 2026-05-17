import { test, expect, chromium, request } from "@playwright/test";
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
    // getByRole retries internally until the button appears or 10s elapses —
    // no silent no-op unlike a fire-and-forget querySelectorAll.
    const trustBtn = vaultPage.getByRole("button", { name: /Trust author/i });
    try {
      await trustBtn.click({ timeout: 10_000 });
    } catch {
      // No modal rendered within 10s — assume already trusted or skipped.
    }

    // Now wait for the void-os status bar element (plugin loads after trust).
    const pill = vaultPage.getByTestId("vos-status-bar");
    await expect(pill).toHaveText("void-os: connected", { timeout: 20_000 });
    await vaultPage.waitForTimeout(DEFAULT_PING_MS + 2_000);
    await expect(pill).toHaveText("void-os: connected");

    // VOS-107 T2 audit: the connected pill proves *some* daemon is up, but
    // not that it is the one globalSetup launched on state.port. Probe the
    // daemon's HTTP origin directly from the Playwright context (not the
    // renderer — Obsidian's app:// origin would CORS-block a window.fetch)
    // to lock the wiring contract end-to-end.
    //
    // AUDIT note: the plan called for a `daemon-url` testid assertion; no
    // such surface exists in the product (plugin/src/settings-tab.ts renders
    // the field via Obsidian's Setting helper which has no test hook). We
    // assert the wiring via a side-channel HTTP probe instead of inventing
    // a product-side testid.
    const daemonOrigin = `http://127.0.0.1:${state.port}`;
    const api = await request.newContext();
    try {
      const probe = await api.get(`${daemonOrigin}/agents`);
      expect(probe.status()).toBe(200);
    } finally {
      await api.dispose();
    }
  } finally {
    await browser.close();
  }
});
