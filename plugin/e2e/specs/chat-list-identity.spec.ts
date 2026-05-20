// VOS-153 T9 — chat-list identity surface e2e.
//
// Locks the T8 ChatList enrichment: every row carries the bound agent's
// emoji avatar and a CSS `--agent-color` custom property sourced from
// agent.md frontmatter. The new chat-row-stripe + chat-row-emoji testids
// are the contract; CSS class names are intentionally NOT asserted on.
//
// Test mints a chat via REST (mintChat) — bypassing the picker is faster
// and avoids re-covering ground owned by agent-picker.spec.ts /
// no-empty-chats.spec.ts. The row's emoji + colour are then asserted
// against the values committed to fixtures/agents-rich/maya/agent.md
// (avatar "🔬", color "#5a8fd4"), which globalSetup.ts copies into the
// daemon vault as agents/maya/agent.md at boot.

import { test, expect, request } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getVaultPage } from "../helpers/vault-page.ts";
import { mintChat, sendMessage } from "../helpers/daemon-api.ts";
import { withFixtureSwap } from "../helpers/fixture-swap.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAYA_SCRIPT = path.join(HERE, "..", "fixtures", "ask-agent", "maya.jsonl");

// Minimal "one assistant text turn then result" fake-provider script.
// Populates last_msg on the chat row so ChatList's `isEmpty` filter
// (ChatList.tsx:64) doesn't hide it. Matches the safe shape from the
// chat-list-polish trap-3 lesson (assistant text BEFORE any directive).
const SIMPLE_SCRIPT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "vos153-t9-identity" }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi back" }],
    },
  }),
  JSON.stringify({ type: "result", subtype: "success" }),
].join("\n") + "\n";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
}

function loadState(): E2EState {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath) throw new Error("VOS_E2E_STATE not set — globalSetup did not run");
  return JSON.parse(readFileSync(statePath, "utf8")) as E2EState;
}

test("VOS-153 T9: chat list row surfaces agent emoji + color stripe", async () => {
  test.setTimeout(90_000);
  const state = loadState();

  await withFixtureSwap(MAYA_SCRIPT, SIMPLE_SCRIPT, async () => {
    const { browser, page } = await getVaultPage(state.cdpPort);
    const api = await request.newContext({
      baseURL: `http://127.0.0.1:${state.port}`,
    });
    try {
      // Plugin connected.
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 20_000 });

      // Drive ChatView open so the ChatList sidebar is rendered.
      await page.evaluate(() => {
        // @ts-ignore
        window.app.commands.executeCommandById("void-os:open-chat-view");
      });
      await expect(page.getByTestId("vos-chat-root")).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      // Mint a chat via REST and send a message so the chat has a
      // non-empty last_msg. ChatList's `isEmpty` filter (ChatList.tsx:64)
      // hides rows with no title and no last_msg — without sendMessage,
      // the row would never render. The fixture-swap above pins maya to
      // a one-shot assistant text fixture so the run completes fast.
      const { chatId } = await mintChat(api, "maya");
      await sendMessage(api, chatId, "hi");

      // The ChatList polls /chats every POLL_MS and listens for bus
      // refresh events. Locate the row by its precise testid.
      const row = page.locator(`[data-testid='chat-row-${chatId}']`);
      await expect(row).toBeVisible({ timeout: 30_000 });

      // Emoji: chat-row-emoji testid wraps the agent's avatar character.
      // VOS-153 T9 fixture pins maya.avatar = "🔬".
      const emoji = row.locator("[data-testid='chat-row-emoji']");
      await expect(emoji).toHaveText("🔬", { timeout: 5_000 });

      // Stripe: the row itself carries the inline `--agent-color` custom
      // property (see ChatList.tsx:170). getComputedStyle resolves the
      // custom-prop value as the author-supplied string.
      const stripeColor = await row.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--agent-color").trim(),
      );
      expect(stripeColor).toBe("#5a8fd4");

      // The dedicated `chat-row-stripe` span is also present and visible.
      await expect(row.locator("[data-testid='chat-row-stripe']")).toBeVisible();

      // data-agent on the row mirrors the bound agent's name (cheap
      // belt + suspenders that the mint actually carried agent=maya).
      await expect(row).toHaveAttribute("data-agent", "maya");
    } finally {
      await api.dispose();
      await browser.close();
    }
  });
});
