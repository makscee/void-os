/**
 * VOS-109 T7: real-browser E2E for the denial chip.
 *
 * Runs in its own Playwright project `permission-deny-ui` (see
 * playwright.config.ts) whose dedicated daemon has
 * VOS_FAKE_SCRIPT_maya = fixtures/permission-deny/maya.jsonl. The fixture
 * drives the maya agent to attempt a `vault.create` against
 * `journal/forbidden.md`. maya's seeded agent_card declares
 * write_scope:[] (globalSetup.ts L285-289), so the MCP scope-gate denies
 * the write; the daemon's denial synthesiser (VOS-109 T2/T3) appends a
 * DataPart{data:{kind:"denial",…}} in the same parts event; the plugin
 * renders it via the data.by_name.denial slot (VOS-109 T5) with
 * data-testid="turn-denial".
 *
 * Pattern mirrors ask-user.spec.ts (sibling dedicated-project spec):
 *   1. Read state from VOS_E2E_STATE_PERMISSION_DENY.
 *   2. POST /chats with {agent:"maya"} to mint a chat.
 *   3. POST /chat/:id/message with {text:"go"} to kick the run.
 *   4. CDP-connect to Obsidian, open chat view via command palette,
 *      click the chat row, assert the denial chip surfaces and the
 *      composer stays usable.
 */
import {
  test,
  expect,
  type Page,
  type Locator,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { getVaultPage } from "../helpers/vault-page.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
  dbPath: string;
}

function readPermissionDenyState(): E2EState {
  const p = process.env.VOS_E2E_STATE_PERMISSION_DENY;
  if (!p) {
    throw new Error(
      "VOS_E2E_STATE_PERMISSION_DENY not set — globalSetup-permission-deny-ui.ts did not run",
    );
  }
  return JSON.parse(readFileSync(p, "utf8")) as E2EState;
}

async function openChatRoot(page: Page, chatId: string): Promise<Locator> {
  await expect(page.getByTestId("vos-status-bar"))
    .toHaveText("void-os: connected", { timeout: 20_000 });
  await page.evaluate(() => {
    // @ts-ignore — Obsidian renderer global.
    window.app.commands.executeCommandById("void-os:open-chat-view");
  });
  const chatRoot = page.getByTestId("vos-chat-root");
  await expect(chatRoot).toBeVisible({ timeout: 10_000 });
  // Dismiss any first-launch modal (Settings / Community-plugins).
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const row = page.locator(`[data-chat-id="${chatId}"]`).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click({ force: true });
  return chatRoot;
}

test.describe("UI denial chip (VOS-109 T7)", () => {
  test.setTimeout(120_000);

  test("UI surfaces denial when agent attempts cross-scope write", async ({ request }) => {
    const state = readPermissionDenyState();

    // Mint a chat against the permission-deny daemon.
    const createRes = await request.post(`http://127.0.0.1:${state.port}/chats`, {
      data: { agent: "maya" },
    });
    expect(createRes.status()).toBe(200);
    const created = (await createRes.json()) as { id: string };
    const chatId = created.id;
    expect(chatId).toBeTruthy();

    // Kick the run. The maya fixture emits a tool_use vault.create which
    // the scope-gate denies; the run terminates after the synthesised
    // denial DataPart lands. POST /chat/:id/message blocks until run.end,
    // so we await it.
    const sendRes = await request.post(
      `http://127.0.0.1:${state.port}/chat/${chatId}/message`,
      { data: { text: "go" } },
    );
    expect(sendRes.status()).toBe(200);

    // Drive the UI: open the chat view, find the denial chip, assert
    // composer stays enabled.
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      const chatRoot = await openChatRoot(page, chatId);

      const denial = chatRoot.getByTestId("turn-denial");
      await expect(denial).toBeVisible({ timeout: 15_000 });
      await expect(denial).toHaveText(/denied|forbidden|not allowed/i);

      // Composer stays usable after denial: the spec's contract is that
      // the user can still type a follow-up. ChatRoot renders the
      // ComposerPrimitive.Input as a textarea with placeholder="Message"
      // (see chat-roundtrip.spec.ts L88).
      const composer = chatRoot.getByPlaceholder("Message");
      await expect(composer).toBeVisible();
      await expect(composer).toBeEditable();
    } finally {
      await browser.close();
    }
  });
});
