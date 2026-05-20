// VOS-126 → VOS-153 T10 rewrite: the "no-agent send" path no longer
// exists. T5's state machine renders the Idle pane (no agent picked, no
// chatId persisted) with the empty hint only — there is no composer
// surface at all. You cannot send-without-agent because you cannot
// send: the textarea and Send button are gated behind picking an agent
// (Draft pane) or selecting an existing chat (Active pane).
//
// This spec used to assert the VOS-126 composer-toast flow:
//   * fresh view + no defaultAgent → composer visible → fill → click Send
//   * daemon 400 E_INVALID_BODY → onComposerToast(NO_AGENT_TOAST_COPY)
//   * `ask-user-toast` testid renders with "Pick an agent first" copy
//
// After T5 (chat-screen agent-centric UX), the composer simply does
// not mount in Idle. The toast-path code in runtime.ts is still wired
// for createChat failures in other branches (Draft-send rollback, etc),
// but the no-agent toast is unreachable through the UI by construction.
//
// The rewritten spec proves the new invariant end-to-end:
//   1. Clear settings.chatId and reopen the view fresh.
//   2. Pane lands in Idle (`chat-empty` testid visible, hint copy
//      present).
//   3. There is NO composer surface — neither the Draft composer
//      (`draft-composer`) nor the Active-pane Message placeholder.
//   4. There is NO Send button.
//   5. /chats remains unchanged (no zombie row).
//
// Together those assertions lock the property "you cannot send without
// an agent" without depending on the toast path, which VOS-153
// intentionally removed from the user-reachable graph.

import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

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

test("no-agent send: Idle pane has no composer, no chat row can be created", async ({ request }) => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    // Precondition: plugin connected to daemon.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // Snapshot existing chat ids — sibling specs (chat-roundtrip,
    // ask-agent, etc) mint chats earlier in the worker. We assert NO new
    // row appears in this slice.
    const beforeRes = await request.get(`http://127.0.0.1:${state.port}/chats`);
    expect(beforeRes.status()).toBe(200);
    const beforeBody = (await beforeRes.json()) as Array<{ id: string }>;
    const beforeIds = new Set(beforeBody.map((c) => c.id));

    // Detach any open chat view leaves AND clear the plugin's persisted
    // settings.chatId. Same monkey-patch pattern as the original VOS-126
    // spec: SettingsStore caches `current` in a closure, so we have to
    // force the construction-time read to null so the new ChatRoot mounts
    // with props.chatId = null. Without this the pane lands directly in
    // Active using the previously-persisted chat id and the assertions
    // below fail for the wrong reason.
    await page.evaluate(() => {
      // @ts-ignore — `app` is Obsidian's global in the renderer.
      const app = window.app;
      app.workspace.detachLeavesOfType("void-os-chat");
      const plugin = app.plugins.plugins["void-os"];
      const store = plugin.settings;
      const origGet = store.get.bind(store);
      store.get = () => ({ ...origGet(), chatId: null });
      return plugin.saveData({ ...origGet(), chatId: null });
    });

    await page.evaluate(() => {
      // @ts-ignore
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    const chatRoot = page.getByTestId("vos-chat-root");
    await expect(chatRoot).toBeVisible({ timeout: 10_000 });

    // Dismiss any first-launch modal still hanging around.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Assertion 1: Idle pane is mounted with the empty hint copy.
    const empty = page.getByTestId("chat-empty");
    await expect(empty).toBeVisible({ timeout: 10_000 });
    await expect(empty).toContainText("pick an agent");

    // Assertion 2: neither the Draft pane nor the Active pane is mounted.
    await expect(page.getByTestId("chat-draft")).toHaveCount(0);
    await expect(page.getByTestId("chat-active")).toHaveCount(0);

    // Assertion 3: there is NO composer surface anywhere in the chat
    // root — not the Draft composer textarea, not the Active-pane
    // ComposerPrimitive.Input (placeholder="Message").
    await expect(chatRoot.getByTestId("draft-composer")).toHaveCount(0);
    await expect(chatRoot.getByPlaceholder("Message")).toHaveCount(0);

    // Assertion 4: there is NO Send button while Idle.
    await expect(chatRoot.getByRole("button", { name: "Send" })).toHaveCount(0);

    // Assertion 5: /chats unchanged — Idle by construction cannot mint
    // a chat row (no createChat call site reachable from this state).
    const afterRes = await request.get(`http://127.0.0.1:${state.port}/chats`);
    expect(afterRes.status()).toBe(200);
    const afterBody = (await afterRes.json()) as Array<{ id: string }>;
    const newRows = afterBody.filter((c) => !beforeIds.has(c.id));
    expect(newRows, "Idle pane must not create a chat row").toEqual([]);
  } finally {
    await browser.close();
  }
});
