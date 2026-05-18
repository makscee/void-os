// VOS-126: ChatView sendText with no agent picked → composer toast UX.
//
// Asserts: with `settings.chatId` cleared and `defaultAgent` undefined (the
// production wiring per main.ts:225-237), typing into the composer and
// pressing Send fires `createChat()` with no agent → daemon returns
// 400 E_INVALID_BODY → runtime calls `onComposerToast(NO_AGENT_TOAST_COPY)`
// → ChatRoot renders the toast at `data-testid="ask-user-toast"`. Also
// asserts no zombie chat row appears in the daemon's /chats list.
//
// Why we don't just open the view: prior specs in this Playwright project
// (chat-roundtrip, ask-agent, etc.) mint chats and persist `settings.chatId`
// via the `onChatIdMinted → settings.setChatId` hook in main.ts. That makes
// `ensureChat` short-circuit on the cached id. To drive the no-agent path
// reliably, we (a) detach all open void-os-chat leaves, (b) overwrite the
// plugin's persisted settings to clear `chatId`, then (c) reopen the chat
// view so the ChatView deps factory re-reads `settings.get().chatId = null`.
//
// Selectors are lifted from chat-roundtrip + ChatRoot.tsx — no helper module
// exists in this harness (`feedback_void_os_e2e_gotchas`: no helpers; we
// inline CDP connect / Trust-author / view-open just like sibling specs).
// The composer is the standard ComposerPrimitive.Input with
// placeholder="Message"; Send is the role=button name="Send".
// Toast surface: `data-testid="ask-user-toast"` (reused for all composer
// toasts in ChatRoot, including the VOS-126 no-agent copy).

import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { NO_AGENT_TOAST_COPY } from "../../src/chat/runtime";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
}

async function getVaultPage(cdpPort: number): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  let page = browser.contexts().flatMap((ctx) => ctx.pages())
    .find((p) => p.url() === "app://obsidian.md/index.html");

  if (!page) {
    const ctx = browser.contexts()[0];
    page = await ctx.waitForEvent("page", {
      predicate: (p) => p.url() === "app://obsidian.md/index.html",
      timeout: 20_000,
    });
  }
  await page.waitForLoadState("domcontentloaded");

  try {
    await page.getByRole("button", { name: /Trust author/i }).click({ timeout: 5_000 });
  } catch { /* already trusted */ }
  return { browser, page };
}

test("no-agent send: composer toast surfaces, no chat row created (VOS-126)", async ({ request }) => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    // Precondition: plugin connected to daemon.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // Snapshot existing chat ids — sibling specs (chat-roundtrip, ask-agent,
    // agent-picker, ...) mint chats earlier in the run. We assert NO NEW row
    // appears in this slice; the baseline set is whatever the daemon has now.
    const beforeRes = await request.get(`http://127.0.0.1:${state.port}/chats`);
    expect(beforeRes.status()).toBe(200);
    const beforeBody = (await beforeRes.json()) as Array<{ id: string }>;
    const beforeIds = new Set(beforeBody.map((c) => c.id));

    // Detach any open chat view leaves AND clear the plugin's persisted
    // settings.chatId. Then reopen the chat view fresh — the ChatView deps
    // factory at main.ts:225 reads `settings.get().chatId` at construction,
    // so the new ChatRoot mounts with `props.chatId = null`. That guarantees
    // `chatIdRef.current` starts null and `ensureChat` will fire createChat
    // with undefined defaultAgent → daemon 400 → toast path.
    await page.evaluate(() => {
      // @ts-ignore — `app` is Obsidian's global in the renderer.
      const app = window.app;
      app.workspace.detachLeavesOfType("void-os-chat");
      const plugin = app.plugins.plugins["void-os"];
      // SettingsStore.setChatId only accepts string, so we bypass and write
      // via the Plugin saveData() API directly (same path setChatId uses).
      return plugin.saveData({ ...(plugin.settings?.get?.() ?? {}), chatId: null });
    });

    await page.evaluate(() => {
      // @ts-ignore
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    const chatRoot = page.getByTestId("vos-chat-root");
    await expect(chatRoot).toBeVisible({ timeout: 10_000 });

    // Dismiss the fresh-vault Settings / Community-plugins modal that may
    // still be open from earlier specs in this worker.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Drive the composer. We deliberately DO NOT open the agent picker
    // (new-chat-btn) — the whole point of VOS-126 is that the user types
    // into a fresh view and presses Send without ever picking.
    const composer = chatRoot.getByPlaceholder("Message");
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await expect(composer).toBeEditable({ timeout: 5_000 });
    await composer.fill("hello with no agent");

    const sendBtn = chatRoot.getByRole("button", { name: "Send" });
    await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
    await sendBtn.click();

    // Assertion 1: the no-agent toast renders with the exact copy from
    // runtime.ts. Reuses the ask-user-toast testid (single composer toast
    // surface in ChatRoot.tsx; the testid name is historical).
    const toast = chatRoot.getByTestId("ask-user-toast");
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toHaveText(NO_AGENT_TOAST_COPY);

    // Belt-and-braces: the literal user-facing prefix is asserted so a
    // future copy tweak that drops the actionable phrase fails loudly.
    await expect(toast).toContainText("Pick an agent first");
    await expect(toast).toContainText("new-chat-with-agent");

    // Assertion 2: no zombie chat row was created by the rejected POST.
    // Daemon /chats should still equal the baseline set — the 400 path in
    // chats.ts:23 rejects BEFORE inserting any row.
    const afterRes = await request.get(`http://127.0.0.1:${state.port}/chats`);
    expect(afterRes.status()).toBe(200);
    const afterBody = (await afterRes.json()) as Array<{ id: string }>;
    const newRows = afterBody.filter((c) => !beforeIds.has(c.id));
    expect(newRows, "no chat row should be created when agent is missing").toEqual([]);

    // Assertion 3: the composer is still usable (not stuck in some error
    // state). The plain Message placeholder is back (no pendingAskUser
    // mode-switch), and the textarea is still editable.
    await expect(composer).toBeVisible();
    await expect(composer).toBeEditable();
  } finally {
    await browser.close();
  }
});
