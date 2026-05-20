import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { waitForTaskRow, waitForTaskState, type TaskRow } from "../test-utils/wait-for-state.ts";
import { getVaultPage } from "../helpers/vault-page.ts";

/**
 * Chat round-trip smoke. Drives the plugin from a connected state through
 * picking an agent, composing a message, sending, and asserting the fake
 * provider's canned assistant reply renders in the thread.
 *
 * VOS-153 T10 update: the spec previously minted the chat by clicking
 * `new-chat-btn` (which opens the legacy SuggestModal picker) and then
 * the first suggestion. After T5+T6+T7 the canonical mint path is the
 * AgentList rail row → Draft pane → first send (no chat row is created
 * until send lands; cf. no-empty-chats.spec.ts). This spec now exercises
 * that contract end-to-end:
 *
 *   click rail row → Draft → fill composer → Send → Active pane mounts
 *     with the T7 ChatHeader → fake provider replies → DB row terminates
 *     COMPLETED.
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
  dbPath: string;
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

    // VOS-153 T6: click the maya rail row. Selector pattern matches T9
    // (no-empty-chats / agents-list-rail): `agent-row` testid with the
    // `data-agent-name` attribute for per-agent disambiguation.
    const mayaRow = page.locator("[data-testid='agent-row'][data-agent-name='maya']");
    await expect(mayaRow).toBeVisible({ timeout: 10_000 });
    await mayaRow.click({ force: true, timeout: 5_000 });

    // VOS-153 T5: Draft pane is mounted. Use the dedicated draft composer
    // testid — the active-pane composer has the same `Message` placeholder
    // and would otherwise be ambiguous.
    await expect(page.getByTestId("draft-label")).toBeVisible({ timeout: 5_000 });
    const draftComposer = page.getByTestId("draft-composer");
    await expect(draftComposer).toBeVisible({ timeout: 5_000 });
    await expect(draftComposer).toBeEditable({ timeout: 5_000 });
    await draftComposer.fill("ping");

    // Send via Enter — DraftComposer wires Enter (no shift) to onDraftSend,
    // which calls api.createChat({agent: "maya"}) then api.postMessage().
    // The pane flips to Active on success.
    await draftComposer.press("Enter");

    // VOS-153 T7: ChatHeader (Active-pane banner) must mount with maya's
    // identity from the rich-frontmatter fixture (description includes
    // "researcher"). This proves both the Draft→Active transition AND
    // that the agent-identity surface is wired.
    const header = page.getByTestId("chat-header");
    await expect(header).toBeVisible({ timeout: 15_000 });
    await expect(header).toContainText("maya");
    await expect(header).toContainText("researcher");

    // Daemon orchestrator runs the fake provider, streams chat.token frames;
    // plugin runtime appends to the thread; MarkdownText renders as a <p>.
    // "hello from fake" also appears in the ChatList row's last_msg preview,
    // so we scope the assertion to the rendered markdown paragraph.
    await expect(chatRoot.getByRole("paragraph").filter({ hasText: "hello from fake" }))
      .toBeVisible({ timeout: 20_000 });

    // VOS-107 T3 audit: lock the task state-machine sequence at the DB
    // boundary. The UI assertion above is necessary but not sufficient —
    // it would still pass if the orchestrator wrote tokens but failed to
    // settle the run to COMPLETED. Pin the contract: a root task exists
    // for the chat we just minted, and it terminates in COMPLETED.
    //
    // Note: collectStatesFor / "states.contains('WORKING')" from the plan
    // requires capturing the transition live. The daemon writes
    // monotonically and quickly past WORKING; observing it post-hoc is
    // racy. Asserting terminal COMPLETED is the durable contract.
    const dbR = new DatabaseSync(state.dbPath, { readOnly: true });
    let parentTaskId: string;
    let contextId: string;
    try {
      const row = dbR
        .prepare(
          "SELECT id, context_id FROM tasks WHERE parent_task_id IS NULL " +
          "ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { id: string; context_id: string };
      parentTaskId = row.id;
      contextId = row.context_id;
    } finally { dbR.close(); }

    const parent = await waitForTaskRow({
      dbPath: state.dbPath,
      contextId,
      predicate: (r: TaskRow) => r.id === parentTaskId,
      timeoutMs: 5_000,
    });
    expect(parent.id).toBe(parentTaskId);
    await waitForTaskState({
      dbPath: state.dbPath,
      taskId: parent.id,
      expected: "TASK_STATE_COMPLETED",
      timeoutMs: 20_000,
    });
  } finally {
    await browser.close();
  }
});
