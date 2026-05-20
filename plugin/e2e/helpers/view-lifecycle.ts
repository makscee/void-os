// plugin/e2e/helpers/view-lifecycle.ts
//
// VOS-153 T1 — close / reopen / probe the chat view leaf from a spec.
// Two consumer specs (T9) will depend on these helpers; the smoke spec
// in this same commit exercises them on a real Obsidian to lock the
// contract before any consumer references them (per
// feedback_e2e_plan_smoke_first).
//
// View type lifted from plugin/src/view.ts:6 — `export const
// CHAT_VIEW_TYPE = "void-os-chat"`. Kept as a literal here so the helper
// has no dependency on plugin/src (e2e/ stays runtime-independent).

import type { Page } from "@playwright/test";

const VIEW_TYPE = "void-os-chat";

/**
 * Detach every leaf of the chat view type and wait for the workspace to
 * settle (0 leaves of the type). Throws if leaves are still present
 * after 5s — that means Obsidian rejected the detach or another caller
 * kept reopening it, both of which the consumer spec wants to know
 * about.
 */
export async function closeChatView(page: Page): Promise<void> {
  await page.evaluate((viewType) => {
    // @ts-expect-error: app is the Obsidian global in the renderer.
    const app = window.app;
    app.workspace.detachLeavesOfType(viewType);
  }, VIEW_TYPE);
  await page.waitForFunction(
    (viewType) => {
      // @ts-expect-error
      const app = window.app;
      return app.workspace.getLeavesOfType(viewType).length === 0;
    },
    VIEW_TYPE,
    { timeout: 5_000 },
  );
}

/**
 * Open a fresh chat view leaf via `getLeaf(true).setViewState(...)` and
 * wait for two signals:
 *   1. a leaf of CHAT_VIEW_TYPE exists in the workspace; and
 *   2. the ChatRoot React tree has mounted (either the testid
 *      `vos-chat-root` or the legacy `.void-os-chat-root` container).
 *
 * The two-selector wait keeps the helper compatible with both the
 * current ChatRoot markup and any future T5 testid tightening.
 */
export async function reopenChatView(page: Page): Promise<void> {
  await page.evaluate(async (viewType) => {
    // @ts-expect-error
    const app = window.app;
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: viewType, active: true });
  }, VIEW_TYPE);
  await page.waitForFunction(
    (viewType) => {
      // @ts-expect-error
      const app = window.app;
      return app.workspace.getLeavesOfType(viewType).length > 0;
    },
    VIEW_TYPE,
    { timeout: 5_000 },
  );
  await page.waitForSelector(
    "[data-testid=vos-chat-root], .void-os-chat-root",
    { timeout: 5_000 },
  );
}

/**
 * True iff at least one leaf of CHAT_VIEW_TYPE is currently in the
 * workspace. Cheap; safe to call repeatedly inside `expect.poll`.
 */
export async function isChatViewOpen(page: Page): Promise<boolean> {
  return await page.evaluate((viewType) => {
    // @ts-expect-error
    const app = window.app;
    return app.workspace.getLeavesOfType(viewType).length > 0;
  }, VIEW_TYPE);
}
