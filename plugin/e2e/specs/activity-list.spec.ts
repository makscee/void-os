import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { request } from "@playwright/test";
import { getVaultPage } from "../helpers/vault-page.ts";
import { mintChat, sendMessage } from "../helpers/daemon-api.ts";

/**
 * VOS-172 — global activity-list UI e2e.
 *
 * The plugin's left rail carries an `activity-list` (every Task across
 * every Context, sorted by last activity, backed by the daemon's
 * `GET /tasks` route). This spec proves the surface end-to-end:
 *
 *   1. Render — seed two chats via REST (each mints a root Task with a
 *      run), open the chat view, assert the activity list shows a row
 *      per Task in activity order.
 *   2. Click — clicking an activity row opens that Task's Context in the
 *      timeline pane (the `chat-active` surface).
 *
 * Chat minting is REST-driven (POST /chats + POST /chat/:id/message) —
 * the picker path is covered by chat-roundtrip.spec.ts. The fake
 * provider's `hello.jsonl` reply gives each Task a non-empty last
 * message so the row's one-liner is observable.
 */

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
  dbPath: string;
}

function loadState(): E2EState {
  return JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
}

test("activity list renders a row per Task and click opens the timeline", async () => {
  test.setTimeout(120_000);
  const state = loadState();

  const api = await request.newContext({
    baseURL: `http://127.0.0.1:${state.port}`,
  });
  let firstContextId = "";
  try {
    // Seed two chats; each POST /chat/:id/message drives a fake-provider
    // run, minting a root Task with activity. The second is created last
    // so it sorts first in the activity-DESC list.
    const c1 = await mintChat(api, "maya");
    await sendMessage(api, c1.chatId, "first task");
    const c2 = await mintChat(api, "maya");
    await sendMessage(api, c2.chatId, "second task");
    firstContextId = c1.chatId; // chatId === context id (POST /chats mints the Context)

    // Pull the daemon's activity list so the spec's row expectations are
    // anchored on real Task ids, not a guess.
    const tasksRes = await api.get("/tasks");
    expect(tasksRes.status()).toBe(200);
    const tasks = (await tasksRes.json()) as Array<{
      id: string;
      context_id: string;
    }>;
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    // Most-recent-first: the second chat's Task heads the list.
    const topTask = tasks[0]!;
    expect(topTask.context_id).toBe(c2.chatId);

    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 20_000 });

      await page.evaluate(() => {
        // @ts-ignore — Obsidian renderer global.
        window.app.commands.executeCommandById("void-os:open-chat-view");
      });
      await expect(page.getByTestId("vos-chat-root"))
        .toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      // 1. Render — the activity list is present with a row per Task.
      const list = page.getByTestId("activity-list");
      await expect(list).toBeVisible({ timeout: 10_000 });

      const topRow = page.locator(
        `[data-testid='activity-row-${topTask.id}']`,
      );
      await expect(topRow).toBeVisible({ timeout: 15_000 });
      // The row carries the Task's owning Context id — the open target.
      await expect(topRow).toHaveAttribute("data-context-id", c2.chatId);

      // 2. Click — opening the Task transitions the pane to Active and
      // mounts the timeline (chat-active surface).
      await topRow.click({ force: true, timeout: 5_000 });
      await expect(page.getByTestId("chat-active"))
        .toBeVisible({ timeout: 15_000 });
      // The opened Context's reply is in the timeline.
      await expect(
        page
          .getByTestId("vos-chat-root")
          .getByRole("paragraph")
          .filter({ hasText: "hello from fake" }),
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await browser.close();
    }
  } finally {
    await api.dispose();
  }
});
