import { test, expect, chromium, type Page, type Browser } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Chat round-trip smoke. Drives the plugin from a connected state through
 * minting a chat, composing a message, sending, and asserting the fake
 * provider's canned assistant reply renders in the thread.
 *
 * Fake script (`fixtures/cc/hello.jsonl`) emits:
 *   {type:"system", subtype:"init", session_id:"e2e-hello"}
 *   {type:"assistant", message:{content:[{type:"text", text:"hello from fake"}]}}
 *
 * Daemon orchestrator turns the assistant event into `chat.token` frames
 * (delta = "hello from fake"). Plugin runtime renders them in the thread.
 */

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

test("chat round-trip: user sends a message, fake provider replies", async () => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    // Precondition: plugin connected to daemon.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // Open chat view.
    await page.evaluate(() => {
      // @ts-ignore — `app` is Obsidian's global in the renderer.
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    const chatRoot = page.getByTestId("vos-chat-root");
    await expect(chatRoot).toBeVisible({ timeout: 10_000 });

    // Obsidian opens the Settings / Community-plugins modal on first launch
    // in a fresh user-data-dir; close any modals with Escape.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Mint a chat. Empty chats are hidden from the ChatList by design
    // (isEmpty filter), so we don't try to wait for a chat-row — the
    // activeChatId is set in React state right after createChat resolves.
    await page.getByTestId("new-chat-btn").click({ force: true, timeout: 5_000 });

    // Composer textarea (ComposerPrimitive.Input, placeholder="Message").
    const composer = chatRoot.getByPlaceholder("Message");
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await composer.fill("ping");

    // Send button: when no run is in flight, ChatRoot renders
    // ComposerPrimitive.Send (not QueueSendButton). It's enabled once the
    // composer has non-empty text. Find it by role + visible name.
    const sendBtn = chatRoot.getByRole("button", { name: "Send" });
    await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
    await sendBtn.click();

    // Daemon orchestrator runs the fake provider, streams chat.token frames;
    // plugin runtime appends to the thread; MarkdownText renders as a <p>.
    // "hello from fake" also appears in the ChatList row's last_msg preview,
    // so we scope the assertion to the rendered markdown paragraph.
    await expect(chatRoot.getByRole("paragraph").filter({ hasText: "hello from fake" }))
      .toBeVisible({ timeout: 20_000 });
  } finally {
    await browser.close();
  }
});
