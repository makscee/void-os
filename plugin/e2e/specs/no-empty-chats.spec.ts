// VOS-153 T9 — "no empty chats" e2e.
//
// Locks the T5 state-machine contract that picking an agent (entering
// Draft) does NOT mint a chat row, and that ONLY sending mints one.
//
// Scenarios:
//   1. Click agent row → Draft → close + reopen ChatView → /chats list
//      is unchanged. (Before T5 the picker minted on click; the new state
//      machine defers minting to the first send.)
//   2. Click agent row → Draft → type + Enter → chat is minted, ChatHeader
//      surfaces the agent, /chats list count is +1.
//
// Selectors bound to actual surface (vs the plan snippet):
//   * Agent row: data-testid="agent-row" + data-agent-name="maya"
//     (NOT `agent-row-maya`). Confirmed against AgentList.tsx:103.
//   * Draft pane label: data-testid="draft-label" (DraftLabel.tsx:14).
//   * Composer: data-testid="draft-composer" textarea (ChatRoot.tsx:863).
//     The plan's CSS-selector fallback ('chat-root textarea') would also
//     match the active-pane composer; the testid is precise.
//   * Chat header: data-testid="chat-header" (ChatHeader.tsx:21).
//
// View-lifecycle helpers (closeChatView / reopenChatView) come from T1;
// listChats / mintChat from daemon-api.ts.

import { test, expect, request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { getVaultPage } from "../helpers/vault-page.ts";
import { closeChatView, reopenChatView } from "../helpers/view-lifecycle.ts";
import { listChats } from "../helpers/daemon-api.ts";

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

test.describe("VOS-153 T9: no empty chats", () => {
  test.setTimeout(90_000);

  test("picking agent without sending does NOT mint a chat row", async () => {
    const state = loadState();
    const { browser, page } = await getVaultPage(state.cdpPort);
    const api = await request.newContext({
      baseURL: `http://127.0.0.1:${state.port}`,
    });
    try {
      // Plugin connected.
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 20_000 });

      // Drive ChatView open via the command palette so we start from a
      // clean view leaf regardless of any sibling-spec residue.
      await page.evaluate(() => {
        // @ts-ignore — Obsidian renderer global.
        window.app.commands.executeCommandById("void-os:open-chat-view");
      });
      await expect(page.getByTestId("vos-chat-root")).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      const before = await listChats(api);

      // Click the maya agent rail row.
      const mayaRow = page.locator("[data-testid='agent-row'][data-agent-name='maya']");
      await expect(mayaRow).toBeVisible({ timeout: 10_000 });
      await mayaRow.click({ force: true, timeout: 5_000 });

      // Draft state observable.
      await expect(page.getByTestId("draft-label")).toBeVisible({ timeout: 5_000 });
      // Belt + suspenders: the chat-active branch must not be mounted.
      await expect(page.getByTestId("chat-active")).toHaveCount(0);

      // Close + reopen the chat view without sending. Reopen mounts a
      // fresh ChatView leaf whose initial pane is "idle" (no draft state
      // is persisted across leaf detach), but more importantly nothing
      // here can mint a chat.
      await closeChatView(page);
      await reopenChatView(page);

      // Settle: list should be unchanged.
      const after = await listChats(api);
      expect(after.length).toBe(before.length);
    } finally {
      await api.dispose();
      await browser.close();
    }
  });

  test("sending from Draft mints the chat and surfaces the header banner", async () => {
    const state = loadState();
    const { browser, page } = await getVaultPage(state.cdpPort);
    const api = await request.newContext({
      baseURL: `http://127.0.0.1:${state.port}`,
    });
    try {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 20_000 });

      await page.evaluate(() => {
        // @ts-ignore
        window.app.commands.executeCommandById("void-os:open-chat-view");
      });
      await expect(page.getByTestId("vos-chat-root")).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      const before = await listChats(api);

      const mayaRow = page.locator("[data-testid='agent-row'][data-agent-name='maya']");
      await expect(mayaRow).toBeVisible({ timeout: 10_000 });
      await mayaRow.click({ force: true, timeout: 5_000 });
      await expect(page.getByTestId("draft-label")).toBeVisible({ timeout: 5_000 });

      // Type into the draft composer (data-testid="draft-composer") +
      // press Enter to trigger onDraftSend → api.createChat → pane flips
      // to Active.
      const composer = page.getByTestId("draft-composer");
      await composer.fill("hello maya");
      await composer.press("Enter");

      // ChatHeader is the Active-pane banner; data-testid="chat-header".
      // Asserting visibility + agent-text confirms both the state flip
      // AND the agent identity surface (T7).
      const header = page.getByTestId("chat-header");
      await expect(header).toBeVisible({ timeout: 30_000 });
      await expect(header).toContainText("maya");

      // Daemon-truth: exactly one new chat row.
      const after = await listChats(api);
      expect(after.length).toBe(before.length + 1);
    } finally {
      await api.dispose();
      await browser.close();
    }
  });
});
