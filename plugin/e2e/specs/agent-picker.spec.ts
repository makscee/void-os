// VOS-107 T10: agent-picker surface S1.
//
// Asserts the new-chat-btn opens the Obsidian SuggestModal-backed agent
// picker, that the daemon-seeded agents (≥2) render as suggestion items,
// that clicking the first option closes the picker, and that the freshly
// created chat carries a non-empty `agent` (the API field is `agent`, not
// `agent_name` — see daemon/src/api/chats.ts:23).
//
// Selectors are class-based to match the existing chat-roundtrip pattern.
// SuggestModal renders `.prompt > input.prompt-input` for the search box
// and `.suggestion-item` rows containing `.void-agent-picker-name` /
// `.void-agent-picker-desc` divs (see plugin/src/agents/picker.ts).
// No new product-side data-testid was added; we reuse what's already on
// the DOM.
//
// Fixture: plugin/e2e/fixtures/daemon-vault now ships maya + journaler
// agent.md stubs so the picker has ≥2 options. Both names are also
// seeded into agent_cards by the shared globalSetup.

import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
}

// Inlined CDP-connect + Trust-author flow. The plugin/e2e harness has no
// shared helpers module — siblings (chat-roundtrip, ask-user) each inline
// this; we follow suit to avoid the "no helpers" trap from the lessons
// file (vault/lessons/void-os-e2e-gotchas).
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

test("agent picker: opens on new-chat-btn, lists agents, records selection", async ({ request }) => {
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

    // Dismiss the fresh-vault Settings / Community-plugins modal that
    // sometimes pops on first launch — mirrors chat-roundtrip.spec.ts.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Snapshot existing chats so we can identify the new one created by
    // picker selection. The list may include rows seeded by sibling specs
    // when this spec runs mid-suite. Per daemon/src/api/chats.ts, GET
    // /chats returns the array directly (not wrapped in {chats: ...}).
    const beforeRes = await request.get(`http://127.0.0.1:${state.port}/chats`);
    expect(beforeRes.status()).toBe(200);
    const beforeBody = (await beforeRes.json()) as Array<{ id: string }>;
    const beforeIds = new Set(beforeBody.map((c) => c.id));

    // Trigger the picker.
    await page.getByTestId("new-chat-btn").click({ force: true, timeout: 5_000 });

    // Picker modal visible — Obsidian's SuggestModal renders `.prompt`
    // with an inner `input.prompt-input`. We assert on both the input
    // and the suggestion list; the input proves the modal mounted, the
    // suggestion-item count proves daemon /agents returned ≥2 rows.
    const pickerInput = page.locator(".prompt input.prompt-input");
    await expect(pickerInput).toBeVisible({ timeout: 10_000 });
    await expect(pickerInput).toHaveAttribute("placeholder", /Pick an agent/i);

    const suggestions = page.locator(".suggestion-item");
    await expect(suggestions.first()).toBeVisible({ timeout: 10_000 });
    // Daemon-vault fixture ships maya + journaler. Picker.ts renders one
    // suggestion per agent returned by GET /agents.
    const suggestionCount = await suggestions.count();
    expect(suggestionCount).toBeGreaterThanOrEqual(2);

    // Each suggestion renders a `.void-agent-picker-name` div with the
    // agent's name — confirm at least one name string is non-empty.
    const firstName = await page.locator(".void-agent-picker-name").first().textContent();
    expect(firstName ?? "").not.toEqual("");

    // Click the first suggestion. Picker.ts wires this to selectSuggestion
    // → onClose → resolve(entry). Wait for the modal to detach.
    await suggestions.first().click();
    await expect(page.locator(".prompt")).toHaveCount(0, { timeout: 5_000 });

    // Daemon API assertion. The picker selection flows through plugin's
    // createChat which POSTs {agent: <name>} to /chats. Poll until a new
    // chat shows up with a non-empty agent — empty chats are listed by
    // the daemon API even though ChatList filters them out client-side.
    let newChat: { id: string; agent?: string } | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await request.get(`http://127.0.0.1:${state.port}/chats`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as Array<{ id: string; agent?: string }>;
      newChat = body.find((c) => !beforeIds.has(c.id));
      if (newChat) break;
      await page.waitForTimeout(200);
    }
    expect(newChat, "new chat row should appear after picker selection").toBeDefined();
    expect(newChat!.agent ?? "").not.toEqual("");
  } finally {
    await browser.close();
  }
});
