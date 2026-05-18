// VOS-91 T19: reload replay E2E.
//
// Validates the T7 synthetic child_task_started + T15 reducer rebuild +
// T16 normalize-replay path together — the exact flow the 6e41bb8 hotfix
// unblocked. Sends a depth-1 ask_agent flow (maya → journaler), waits for
// terminal state, reloads the Obsidian renderer tab, and re-asserts the
// ask_agent card still rendered with its summary, plus that toggling it
// open re-surfaces the journaler's chunk-1 / chunk-2 tokens from the
// replayed message stream (not live WS frames).
//
// Uses the depth-1 subthread fixtures (cheaper than nested) — the default
// journaler script pinned by globalSetup is already the subthread one.

import { test, expect } from "@playwright/test";
import { readFileSync, copyFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  waitForTaskRow,
  waitForTaskState,
  type TaskRow,
} from "../test-utils/wait-for-state.ts";
import { getVaultPage } from "../helpers/vault-page.ts";
import { openEventsWs, callAskAgentOverMcp } from "../helpers/daemon-api.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  dbPath: string;
  journalerActivePath: string;
}

test("reload replay: ask_agent card persists across page reload (T7+T15+T16)", async () => {
  test.setTimeout(180_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;

  // VOS-91 T19: restore the depth-1 journaler fixture in case the nested
  // spec swapped a depth-2 fixture earlier in the run. The active path is
  // shared across specs in the same worker.
  const here = path.dirname(fileURLToPath(import.meta.url));
  copyFileSync(
    path.join(here, "..", "fixtures", "ask-agent-subthread", "journaler.jsonl"),
    state.journalerActivePath,
  );

  const { browser, page } = await getVaultPage(state.cdpPort);

  const events = openEventsWs(state.port);

  // Pre-open WS bridge BEFORE sending message.
  const askAgentResultPromise = (async () => {
    const frame = await events.waitFor(
      (msg) => msg.type === "chat.tool_use" && msg.name === "ask_agent",
      { timeoutMs: 30_000 },
    );
    const chatId = String(frame.chat_id);
    const toolCallId = String(frame.tool_call_id ?? "");
    const input = frame.input as { target_agent_id?: string; message?: string };

    let parentRow: { id: string } | undefined;
    {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const dbR = new DatabaseSync(state.dbPath, { readOnly: true });
        try {
          parentRow = dbR
            .prepare(
              "SELECT id FROM tasks WHERE context_id=? AND parent_task_id IS NULL ORDER BY created_at ASC LIMIT 1",
            )
            .get(chatId) as { id: string } | undefined;
        } finally { dbR.close(); }
        if (parentRow) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    if (!parentRow) throw new Error(`no root task found for chat ${chatId}`);

    return callAskAgentOverMcp({
      port: state.port,
      taskId: parentRow.id,
      contextId: chatId,
      targetAgentId: String(input.target_agent_id ?? "journaler"),
      message: String(input.message ?? "hello"),
      toolCallId,
    });
  })();

  try {
    // Precondition + chat setup.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });
    await page.evaluate(() => {
      // @ts-ignore — Obsidian renderer global.
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    let chatRoot = page.getByTestId("vos-chat-root");
    await expect(chatRoot).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.getByTestId("new-chat-btn").click({ force: true, timeout: 5_000 });
    const pickerInput = page.locator(".prompt input.prompt-input");
    await expect(pickerInput).toBeVisible({ timeout: 10_000 });
    const firstSuggestion = page.locator(".suggestion-item").first();
    await expect(firstSuggestion).toBeVisible({ timeout: 10_000 });
    await firstSuggestion.click();
    await expect(page.locator(".prompt")).toHaveCount(0, { timeout: 5_000 });

    const composer = chatRoot.getByPlaceholder("Message");
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await expect(composer).toBeEditable({ timeout: 5_000 });
    await composer.fill("hello");
    const sendBtn = chatRoot.getByRole("button", { name: "Send" });
    await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
    await sendBtn.click();

    // Wait for live card to reach terminal state.
    const linkedCard = chatRoot.locator('[data-testid="ask-agent-tool"][data-child-task-id]').first();
    await expect(linkedCard).toBeVisible({ timeout: 25_000 });
    const childTaskId = await linkedCard.getAttribute("data-child-task-id");
    const stableCard = chatRoot.locator(`[data-testid="ask-agent-tool"][data-child-task-id="${childTaskId}"]`);

    await askAgentResultPromise;
    await expect(stableCard).toHaveAttribute("data-state", "COMPLETED", { timeout: 30_000 });
    await expect(stableCard).toHaveAttribute("data-expanded", "false");
    await expect(stableCard.locator('[data-testid="ask-agent-summary"]').first())
      .toHaveText(/^journaler answered: /, { timeout: 5_000 });

    // Capture context_id for DB sanity post-reload.
    const contextId = await (async () => {
      const db = new DatabaseSync(state.dbPath, { readOnly: true });
      try {
        const row = db
          .prepare(
            "SELECT context_id FROM tasks WHERE parent_task_id IS NULL ORDER BY created_at DESC LIMIT 1",
          )
          .get() as { context_id: string };
        return row.context_id;
      } finally { db.close(); }
    })();
    const parent = await waitForTaskRow({
      dbPath: state.dbPath,
      contextId,
      predicate: (r: TaskRow) => r.parent_task_id === null,
      timeoutMs: 5_000,
    });
    await waitForTaskState({
      dbPath: state.dbPath,
      taskId: parent.id,
      expected: "TASK_STATE_COMPLETED",
      timeoutMs: 15_000,
    });

    // ── Reload renderer ─────────────────────────────────────────────────
    // Close WS first; spec re-binds nothing after reload (we're testing the
    // pure replay path through HTTP refetch + reducer rebuild).
    events.close();
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    try {
      await page.getByRole("button", { name: /Trust author/i }).click({ timeout: 5_000 });
    } catch { /* already trusted */ }

    // Plugin re-connects to daemon after reload.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 30_000 });

    // Re-open chat view; the just-completed chat should be loadable.
    await page.evaluate(() => {
      // @ts-ignore — Obsidian renderer global.
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    chatRoot = page.getByTestId("vos-chat-root");
    await expect(chatRoot).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Open the just-completed chat from the chat list (selected by chat id).
    const chatRow = page.locator(`[data-testid="chat-row"][data-chat-id="${contextId}"]`);
    await expect(chatRow).toBeVisible({ timeout: 15_000 });
    await chatRow.click();

    // ── Assert ask_agent card is reconstructed from replay ──────────────
    // After T7+T15+T16, normalizeReplay surfaces synthetic
    // child_task_started entries, the reducer rebuilds childTasks, and
    // AskAgentTool renders from the replayed message stream — no live
    // WS frames involved here.
    const replayedCard = chatRoot
      .locator(`[data-testid="ask-agent-tool"][data-child-task-id="${childTaskId}"]`);
    await expect(replayedCard).toBeVisible({ timeout: 20_000 });
    await expect(replayedCard).toHaveAttribute("data-state", "COMPLETED");
    await expect(replayedCard).toHaveAttribute("data-expanded", "false");
    await expect(replayedCard.locator('[data-testid="ask-agent-summary"]').first())
      .toHaveText(/^journaler answered: /, { timeout: 5_000 });

    // Click the toggle → expand → assert replayed chunk-1 / chunk-2 tokens.
    await replayedCard.locator("button").first().click();
    await expect(replayedCard).toHaveAttribute("data-expanded", "true");
    await expect(replayedCard).toContainText("chunk-1", { timeout: 5_000 });
    await expect(replayedCard).toContainText("chunk-2", { timeout: 5_000 });
  } finally {
    events.close();
    await browser.close();
  }
});
