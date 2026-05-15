import {
  test,
  expect,
  chromium,
  request,
  type Browser,
  type Page,
} from "@playwright/test";
import { readFileSync, copyFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VOS-90 T8 — ask_user inline rendering e2e.
 *
 * Three scenarios:
 *   1. Options happy-path: prompt renders with buttons; clicking an option
 *      streams the canned assistant reply ("chose red").
 *   2. Free-form happy-path: composer flips into answer-mode (banner +
 *      ask-user-composer testid + "Type your answer…" placeholder); typed
 *      text resolves the prompt; reply streams ("hello, world").
 *   3. Cross-tab 409 race: a direct POST /chat/:id/answer resolves the
 *      pending question (simulating a second tab); a stale UI click on
 *      the now-deleted option is tolerated (button may have disappeared);
 *      the canned reply still lands; banner clears.
 *
 * Fixtures live in plugin/e2e/fixtures/cc/ (T7). The daemon's fake
 * provider reads VOS_FAKE_SCRIPT, which globalSetup pins to a
 * per-run tmp file (state.fakeScriptPath). Specs swap in a different
 * fixture by copying it onto that path BEFORE kicking the chat.
 */

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
  tmpdir: string;
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

function loadState(): E2EState {
  return JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8"));
}

function activateFixture(state: E2EState, fixtureName: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.join(here, "..", "fixtures", "cc", fixtureName);
  copyFileSync(src, state.fakeScriptPath);
}

async function openChatAndMint(page: Page) {
  await expect(page.getByTestId("vos-status-bar"))
    .toHaveText("void-os: connected", { timeout: 20_000 });
  await page.evaluate(() => {
    // @ts-ignore — Obsidian renderer global.
    window.app.commands.executeCommandById("void-os:open-chat-view");
  });
  const chatRoot = page.getByTestId("vos-chat-root");
  await expect(chatRoot).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByTestId("new-chat-btn").click({ force: true, timeout: 5_000 });
  // VOS-92 wired new-chat-btn to open the agent picker (Obsidian SuggestModal).
  // Daemon-vault fixture (`agents/maya/agent.md`) seeds the agents table so
  // the picker has a `maya` row. Click the first suggestion-item directly —
  // this fires SuggestModal.selectSuggestion which mints the chat through
  // wireOnNewChat. Pressing Enter on the input is unreliable: SuggestModal's
  // chooser only reacts to Enter when a suggestion is highlighted, and the
  // initial highlight does not always land before the keystroke.
  const pickerInput = page.locator(".prompt input.prompt-input");
  await expect(pickerInput).toBeVisible({ timeout: 10_000 });
  const firstSuggestion = page.locator(".suggestion-item").first();
  await expect(firstSuggestion).toBeVisible({ timeout: 10_000 });
  await firstSuggestion.click();
  // Picker must detach (no .prompt root) before the spec proceeds; otherwise
  // subsequent composer.fill / Send routes through the picker input instead
  // of the chat composer.
  await expect(page.locator(".prompt")).toHaveCount(0, { timeout: 5_000 });
  const composer = chatRoot.getByPlaceholder("Message");
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await expect(composer).toBeEditable({ timeout: 5_000 });
  return chatRoot;
}

test.describe("ask_user inline rendering", () => {
  test.setTimeout(120_000);

  test("options happy-path: click red → chose red", async () => {
    const state = loadState();
    activateFixture(state, "ask-with-options.jsonl");
    const { page: p } = await getVaultPage(state.cdpPort);
    const chatRoot = await openChatAndMint(p);

    const composer = chatRoot.getByPlaceholder("Message");
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await composer.fill("go");
    await chatRoot.getByRole("button", { name: "Send" }).click();

    const prompt = chatRoot.getByTestId("ask-user-prompt");
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await expect(prompt).toContainText("Pick a color");

    // Composer flips into buttons-only mode while the prompt is open:
    // banner present with data-banner-mode="blocked", Send button hidden.
    const banner = chatRoot.getByTestId("ask-user-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-banner-mode", "blocked");

    // Wait for both option buttons to be rendered + enabled before clicking,
    // so the assistant-ui store has settled on its tool_use part view.
    // Without this, a fast click can race with @assistant-ui/store's
    // tapClientLookup (Index out of bounds) on a mid-update part list.
    const options = chatRoot.getByTestId("ask-user-option");
    await expect(options).toHaveCount(2);
    await expect(options.first()).toBeEnabled();
    await expect(options.last()).toBeEnabled();

    const red = chatRoot.getByTestId("ask-user-option").filter({ hasText: "red" });
    await red.click();

    // Assert assistant text streamed back. The chatRoot div has
    // display:contents (zero bounding box), so chained locators that
    // resolve through chatRoot first (chatRoot.getByText / getByRole) are
    // unreliable in this Playwright version — they appear to fail to find
    // descendants. Use a flat CSS selector against the page so the descendant
    // <p> is matched directly. The ChatList row also previews "chose red"
    // in its last_msg, but the .vos-md class is unique to the assistant
    // markdown render.
    // chatRoot uses display:contents; chained-locator visibility checks for
    // descendants resolve to 0 in this Playwright build. Poll the raw DOM
    // instead — the assistant's MarkdownText emits <p> descendants of the
    // chatRoot subtree, so the presence-count is unambiguous.
    await expect
      .poll(
        () =>
          p.evaluate(() => {
            const root = document.querySelector('[data-testid="vos-chat-root"]');
            if (!root) return 0;
            return Array.from(root.querySelectorAll("p")).filter((n) =>
              (n.textContent ?? "").includes("chose red"),
            ).length;
          }),
        { timeout: 20_000, intervals: [200] },
      )
      .toBeGreaterThan(0);
  });

  test("free-form happy-path: type 'world' → hello, world", async () => {
    const state = loadState();
    activateFixture(state, "ask-no-options.jsonl");
    const { page: p } = await getVaultPage(state.cdpPort);
    const chatRoot = await openChatAndMint(p);

    const sendStart = chatRoot.getByPlaceholder("Message");
    await expect(sendStart).toBeVisible({ timeout: 5_000 });
    await sendStart.fill("go");
    await chatRoot.getByRole("button", { name: "Send" }).click();

    const banner = chatRoot.getByTestId("ask-user-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toHaveAttribute("data-banner-mode", "answer");
    await expect(banner).toContainText("Your name?");

    const answer = chatRoot.getByTestId("ask-user-composer");
    await expect(answer).toBeEditable();
    await answer.fill("world");
    await chatRoot.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(
        () =>
          p.evaluate(() => {
            const root = document.querySelector('[data-testid="vos-chat-root"]');
            if (!root) return 0;
            return Array.from(root.querySelectorAll("p")).filter((n) =>
              (n.textContent ?? "").includes("hello, world"),
            ).length;
          }),
        { timeout: 20_000, intervals: [200] },
      )
      .toBeGreaterThan(0);
  });

  test("cross-tab 409 race: direct POST resolves; stale UI click tolerated; reply lands; banner clears", async () => {
    const state = loadState();
    activateFixture(state, "ask-with-options.jsonl");
    const { page: p } = await getVaultPage(state.cdpPort);
    const chatRoot = await openChatAndMint(p);
    const composer = chatRoot.getByPlaceholder("Message");
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await composer.fill("go");
    await chatRoot.getByRole("button", { name: "Send" }).click();

    // Wait until the prompt is visible — by the time the prompt renders
    // the daemon has already armed the pending registry, so the direct
    // POST below will succeed (not race ahead of arming).
    const prompt = chatRoot.getByTestId("ask-user-prompt");
    await expect(prompt).toBeVisible({ timeout: 30_000 });

    // Resolve the active chat id by walking /chats and picking the most
    // recently updated row. Use a Playwright request context (loopback
    // fetch from inside the Electron renderer's origin is blocked by
    // CORS — the plugin uses its own fetch with privileged perms).
    const api = await request.newContext({ baseURL: `http://127.0.0.1:${state.port}` });
    try {
      const chatsRes = await api.get("/chats");
      const list = (await chatsRes.json()) as Array<{ id: string; updated_at?: number }>;
      const resolvedChatId = [...list]
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0]?.id ?? "";
      expect(resolvedChatId).not.toBe("");

      // Find the open ask_user tool_use_id via the messages replay.
      const msgsRes = await api.get(`/chat/${resolvedChatId}/messages`);
      const messages = (await msgsRes.json()) as Array<{
        role: string;
        tool_call_id?: string;
        name?: string;
      }>;
      const askUseRow = [...messages]
        .reverse()
        .find((m) => m.role === "tool_use" && m.name === "ask_user");
      expect(askUseRow?.tool_call_id).toBeTruthy();

      // Simulate a second tab resolving the prompt directly.
      const ansRes = await api.post(`/chat/${resolvedChatId}/answer`, {
        data: { tool_use_id: askUseRow!.tool_call_id, answer: "red" },
      });
      expect(ansRes.status()).toBe(200);
    } finally {
      await api.dispose();
    }

    // Click stale option. The button may have already disappeared
    // because chat.tool_result echoed and the reducer cleared
    // pendingAskUser — that's fine, swallow the click failure.
    // If the click does land, the plugin's AskUserTool sees a 409 from
    // /answer and surfaces a toast ("Question already resolved.").
    const blue = chatRoot.getByTestId("ask-user-option").filter({ hasText: "blue" });
    const blueClicked = await blue
      .click({ force: true, timeout: 2_000 })
      .then(() => true)
      .catch(() => false);

    // Primary outcome: the answer that actually won the race ("red")
    // streams as the assistant reply. This is the recovery contract —
    // the run continues regardless of which side won the race.
    // chatRoot uses display:contents; chained-locator visibility checks for
    // descendants resolve to 0 in this Playwright build. Poll the raw DOM
    // instead — the assistant's MarkdownText emits <p> descendants of the
    // chatRoot subtree, so the presence-count is unambiguous.
    await expect
      .poll(
        () =>
          p.evaluate(() => {
            const root = document.querySelector('[data-testid="vos-chat-root"]');
            if (!root) return 0;
            return Array.from(root.querySelectorAll("p")).filter((n) =>
              (n.textContent ?? "").includes("chose red"),
            ).length;
          }),
        { timeout: 20_000, intervals: [200] },
      )
      .toBeGreaterThan(0);

    // Surfacing contract: either the toast informs the user the stale
    // click was rejected, OR the prompt UI is already gone (button
    // disappeared before the click landed). Both are acceptable —
    // what matters is the UI does not silently swallow the 409.
    if (blueClicked) {
      await expect(chatRoot.getByTestId("ask-user-toast")).toBeVisible({
        timeout: 5_000,
      });
    } else {
      // Button disappeared pre-click — option locator must be detached.
      await expect(chatRoot.getByTestId("ask-user-option")).toHaveCount(0);
    }

    // Banner-clear contract (VOS-90 plan, T8): regardless of which path
    // resolved the prompt (echo from daemon or local_answer_409 from the
    // stale click's 409 handler), the ask-user banner must detach.
    await expect(chatRoot.getByTestId("ask-user-banner")).toHaveCount(0, {
      timeout: 10_000,
    });
  });
});
