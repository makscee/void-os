// plugin/e2e/helpers/vault-page.ts
//
// Owns the CDP-connect + Trust-Author boilerplate that every e2e spec
// otherwise inlines (VOS-127 T1). Returns both the Browser and the Page
// because callers need the Browser to `await browser.close()` in their
// `finally`. Pure function, no module-level state — preserves the
// `workers: 1` race-free contract.
//
// Reference inline copy: chat-roundtrip.spec.ts (and 8 siblings).

import { chromium, type Browser, type Page } from "@playwright/test";

export interface GetVaultPageOptions {
  /**
   * Override the vault page URL predicate. Defaults to Obsidian's
   * `app://obsidian.md/index.html`.
   */
  vaultUrl?: string;
  /**
   * Per-step timeout in ms. Applies independently to:
   *   - waitForEvent("page") when no matching page is already present
   *   - Trust-Author button click (best-effort; no failure if absent)
   * Defaults to 20_000 for the page wait and 5_000 for the Trust click,
   * matching the prevailing inline values across the spec corpus.
   */
  pageTimeoutMs?: number;
  trustTimeoutMs?: number;
}

/**
 * Connect to the already-running Obsidian over CDP, locate the vault
 * page, dismiss the first-launch "Trust author" modal if it appears,
 * and wait for `domcontentloaded`.
 *
 * Caller is responsible for `await browser.close()` (typically in a
 * `try { … } finally { await browser.close(); }` block).
 */
export async function getVaultPage(
  cdpPort: number,
  opts: GetVaultPageOptions = {},
): Promise<{ browser: Browser; page: Page }> {
  const vaultUrl = opts.vaultUrl ?? "app://obsidian.md/index.html";
  const pageTimeoutMs = opts.pageTimeoutMs ?? 20_000;
  const trustTimeoutMs = opts.trustTimeoutMs ?? 5_000;

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  let page = browser
    .contexts()
    .flatMap((ctx) => ctx.pages())
    .find((p) => p.url() === vaultUrl);

  if (!page) {
    const ctx = browser.contexts()[0];
    page = await ctx.waitForEvent("page", {
      predicate: (p) => p.url() === vaultUrl,
      timeout: pageTimeoutMs,
    });
  }

  await page.waitForLoadState("domcontentloaded");

  // Obsidian shows a "Do you trust the author of this vault?" modal on
  // first open in a fresh user-data-dir. Dismiss it so plugins can load.
  // getByRole retries internally until the button appears or the timeout
  // elapses — no silent no-op unlike a fire-and-forget querySelector.
  try {
    await page
      .getByRole("button", { name: /Trust author/i })
      .click({ timeout: trustTimeoutMs });
  } catch {
    // No modal rendered within the window — assume already trusted.
  }

  return { browser, page };
}
