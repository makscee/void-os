/**
 * VOS-107 T9: ask_user inline render + option click + state clears.
 *
 * Surface S2 fix. The legacy spec mutated `fixtures/ask-agent/maya.jsonl`
 * via `activateFixture(copyFileSync ...)` which broke sibling specs that
 * also use the maya agent. This rewrite uses a dedicated Playwright
 * project (defined in playwright.config.ts) with its own daemon whose
 * `VOS_FAKE_SCRIPT_maya` env points at `fixtures/ask-user.jsonl` —
 * see globalSetup-ask-user.ts.
 *
 * Scope: minimal happy-path. Asserts the ask-user-prompt renders with
 * the canned question + the A/B option buttons, that clicking A POSTs
 * to /chat/:id/answer (the AskUserTool wires the click → fetch), and
 * that the task state transitions out of TASK_STATE_INPUT_REQUIRED.
 *
 * Companion fixture: plugin/e2e/fixtures/ask-user.jsonl (3 lines:
 * system init, leading text turn, vos_ask_user directive).
 */
import {
  test,
  expect,
  chromium,
  type Browser,
  type Page,
  type Locator,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { waitForTaskRow } from "../test-utils/wait-for-state.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
  dbPath: string;
}

function readAskUserState(): E2EState {
  // Per playwright.config.ts, this spec runs under the `ask-user` project
  // whose globalSetup-ask-user.ts exposes the sidecar via
  // VOS_E2E_STATE_ASK_USER (not VOS_E2E_STATE).
  const p = process.env.VOS_E2E_STATE_ASK_USER;
  if (!p) throw new Error("VOS_E2E_STATE_ASK_USER not set — globalSetup-ask-user.ts did not run");
  return JSON.parse(readFileSync(p, "utf8")) as E2EState;
}

async function getVaultPage(cdpPort: number): Promise<{ browser: Browser; page: Page }> {
  // Inlined from chat-roundtrip.spec.ts. The plugin/e2e harness has no
  // shared test-helpers module; specs each re-implement the CDP-connect +
  // Trust-author flow. Keeping it inline avoids the lessons file's
  // "no helpers" trap.
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

async function openChatRoot(page: Page, chatId: string): Promise<Locator> {
  // Open the chat view via the plugin's registered command, then wait
  // for the chat-root container. Unlike openChatAndMint (legacy spec) we
  // do NOT click new-chat-btn — the chat is already minted via the
  // /chats POST in the test body. We focus our chat by clicking its
  // ChatList row (data-chat-id="<id>") so ChatRoot binds to it.
  await expect(page.getByTestId("vos-status-bar"))
    .toHaveText("void-os: connected", { timeout: 20_000 });
  await page.evaluate(() => {
    // @ts-ignore — Obsidian renderer global.
    window.app.commands.executeCommandById("void-os:open-chat-view");
  });
  const chatRoot = page.getByTestId("vos-chat-root");
  await expect(chatRoot).toBeVisible({ timeout: 10_000 });
  // Fresh Obsidian user-data sometimes pops the Settings modal on first
  // launch. Dismiss any open modal before targeting ChatList rows —
  // mirrors the legacy openChatAndMint() flow.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const row = page.locator(`[data-chat-id="${chatId}"]`).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click({ force: true });
  return chatRoot;
}

test.describe("ask_user inline rendering (VOS-107 T9)", () => {
  test.setTimeout(120_000);

  test("ask_user inline render + option click + state clears", async ({ request }) => {
    const state = readAskUserState();

    // Mint a chat against the ask-user-isolated daemon. The daemon's POST
    // /chats body shape is {agent: string}, not {agent_name: ...} — the
    // plan's draft text was inaccurate; see daemon/src/api/chats.ts:23.
    const createRes = await request.post(`http://127.0.0.1:${state.port}/chats`, {
      data: { agent: "maya" },
    });
    expect(createRes.status()).toBe(200);
    const created = (await createRes.json()) as { id: string };
    const chatId = created.id;
    expect(chatId).toBeTruthy();

    // Kick the chat. Body shape is {text}, not {content} — see
    // daemon/src/api/chat.ts:143. POST does NOT return until the
    // orchestrator's run.end fires (see chat-list-polish.spec.ts comment
    // on `fireMessageViaApi`). Because vos_ask_user parks the run mid-
    // flight, awaiting this POST would deadlock — the answer POST never
    // gets issued because the test hasn't reached the click yet. Fire
    // and forget; assert the parked state via DB poll below.
    void request
      .post(`http://127.0.0.1:${state.port}/chat/${chatId}/message`, {
        data: { text: "go" },
      })
      .catch(() => undefined);

    // The maya agent (here pinned to fixtures/ask-user.jsonl) emits a
    // vos_ask_user directive which lands as a tool_use on the orchestrator,
    // parks the task in TASK_STATE_INPUT_REQUIRED, and arms the pending
    // answer registry. Poll the DB for the parked state.
    const parkedTask = await waitForTaskRow({
      dbPath: state.dbPath,
      contextId: chatId,
      predicate: (row) => row.state === "TASK_STATE_INPUT_REQUIRED",
      timeoutMs: 30_000,
    });
    expect(parkedTask.state).toBe("TASK_STATE_INPUT_REQUIRED");

    // Drive the UI: open the chat view, find the rendered prompt, click A.
    const { browser, page } = await getVaultPage(state.cdpPort);
    try {
      const chatRoot = await openChatRoot(page, chatId);

      const prompt = chatRoot.getByTestId("ask-user-prompt");
      await expect(prompt).toBeVisible({ timeout: 30_000 });
      await expect(prompt).toContainText("pick one");

      // Option buttons carry data-testid="ask-user-option" + button text =
      // the option string. Use a text-filtered locator to disambiguate A vs B.
      const optionA = prompt.getByTestId("ask-user-option").filter({ hasText: /^A$/ });
      const optionB = prompt.getByTestId("ask-user-option").filter({ hasText: /^B$/ });
      await expect(optionA).toBeVisible();
      await expect(optionB).toBeVisible();

      await optionA.click();

      // After the click, AskUserTool POSTs /chat/:id/answer; the daemon
      // resumes the parked task → state transitions OUT of INPUT_REQUIRED.
      // We don't care which terminal state lands first (WORKING, COMPLETED,
      // FAILED) — only that it's no longer INPUT_REQUIRED.
      const resumed = await waitForTaskRow({
        dbPath: state.dbPath,
        contextId: chatId,
        predicate: (row) => row.state !== "TASK_STATE_INPUT_REQUIRED",
        timeoutMs: 30_000,
      });
      expect(resumed.state).not.toBe("TASK_STATE_INPUT_REQUIRED");
    } finally {
      await browser.close();
    }
  });
});
