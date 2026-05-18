// VOS-91 T19: depth-2 nested ask_agent E2E.
//
// Chain: maya → journaler → deep. Maya emits ask_agent(journaler);
// journaler streams j-chunk-1 then emits ask_agent(deep); deep streams
// d-chunk-1, chunk-2, final-answer-D. The spec's WS bridge handles BOTH
// ask_agent tool_use frames by invoking the daemon's MCP `ask_agent`
// tool — playing the role a real claude-code subprocess plays in
// production for whichever agent issued the call.
//
// Assertions:
//   - outer card (maya's call) appears WORKING + expanded;
//   - inner card (journaler's call), located inside outer card's body,
//     reaches WORKING + expanded;
//   - inner reaches COMPLETED + collapsed + summary "deep answered: ...";
//   - outer reaches COMPLETED + collapsed + summary "journaler answered: ...".
//
// Fixture swap: globalSetup pins VOS_FAKE_SCRIPT_journaler at a mutable
// path (state.journalerActivePath); this spec copies the nested journaler
// fixture (which calls ask_agent(deep)) over it BEFORE kicking the chat.

import { test, expect } from "@playwright/test";
import { readFileSync, copyFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getVaultPage } from "../helpers/vault-page.ts";
import { openEventsWs, callAskAgentOverMcp } from "../helpers/daemon-api.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  dbPath: string;
  journalerActivePath: string;
  deepActivePath: string;
}

interface ToolUseFrame {
  type: string;
  chat_id: string;
  task_id?: string;
  tool_call_id?: string;
  name?: string;
  input?: { target_agent_id?: string; message?: string };
  [k: string]: unknown;
}

/** Resolve the root parent task id for a chat. Race-safe poll. */
async function resolveRootTaskId(dbPath: string, chatId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT id FROM tasks WHERE context_id=? AND parent_task_id IS NULL ORDER BY created_at ASC LIMIT 1",
        )
        .get(chatId) as { id: string } | undefined;
      if (row) return row.id;
    } finally { db.close(); }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no root task found for chat ${chatId}`);
}

test("depth-2 nested ask_agent: maya → journaler → deep, live + auto-collapse", async () => {
  test.setTimeout(180_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;

  // Swap in the depth-2 journaler fixture (calls ask_agent(deep)). Default
  // journaler fixture (depth-1) is restored implicitly by the next spec
  // that runs only if it swaps back; sibling specs use a fresh worker.
  const here = path.dirname(fileURLToPath(import.meta.url));
  copyFileSync(
    path.join(here, "..", "fixtures", "ask-agent-nested", "journaler.jsonl"),
    state.journalerActivePath,
  );

  const { browser, page } = await getVaultPage(state.cdpPort);

  // Bridge BOTH ask_agent tool_use frames into MCP roundtrips. Outer frame
  // has no task_id → resolve via DB; inner frame carries task_id (dispatch-
  // child emit). We dedupe by tool_call_id so we never bridge the same
  // frame twice (parent re-runs after resume can replay tool_use with the
  // same id).
  // Nested spec needs every matching tool_use frame, not just the first —
  // so we bind a raw listener on the helper's underlying ws rather than
  // using `waitFor` (which resolves on first match). Helper buffers frames
  // before we attach, but tool_use frames only arrive AFTER we send the
  // chat message below, so attaching here is race-safe.
  const events = openEventsWs(state.port);
  const bridged = new Set<string>();
  const inflight: Promise<unknown>[] = [];
  events.ws.addEventListener("message", (ev) => {
    let msg: Record<string, unknown>;
    try {
      const raw = typeof ev.data === "string" ? ev.data : (ev.data as { toString(): string }).toString();
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch { return; }
    if (msg.type !== "chat.tool_use" || msg.name !== "ask_agent") return;
    const frame = msg as unknown as ToolUseFrame;
    const callId = String(frame.tool_call_id ?? "");
    if (!callId || bridged.has(callId)) return;
    bridged.add(callId);
    const chatId = String(frame.chat_id);
    const targetAgentId = String(frame.input?.target_agent_id ?? "");
    const message = String(frame.input?.message ?? "");
    inflight.push((async () => {
      const taskId = frame.task_id ? String(frame.task_id) : await resolveRootTaskId(state.dbPath, chatId);
      return callAskAgentOverMcp({
        port: state.port,
        taskId,
        contextId: chatId,
        targetAgentId,
        message,
        toolCallId: callId,
      });
    })());
  });

  try {
    // Precondition.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // Open chat view.
    await page.evaluate(() => {
      // @ts-ignore — Obsidian renderer global.
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    const chatRoot = page.getByTestId("vos-chat-root");
    await expect(chatRoot).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Mint a chat (defaults to maya — first suggestion).
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

    // ── Outer card appears ────────────────────────────────────────────────
    const outerLinked = chatRoot.locator('[data-testid="ask-agent-tool"][data-child-task-id]').first();
    await expect(outerLinked).toBeVisible({ timeout: 25_000 });
    const outerChildId = await outerLinked.getAttribute("data-child-task-id");
    const outerCard = chatRoot
      .locator(`[data-testid="ask-agent-tool"][data-child-task-id="${outerChildId}"]`);
    await expect(outerCard).toHaveAttribute("data-state", "WORKING");
    await expect(outerCard).toHaveAttribute("data-expanded", "true");

    // ── Inner card appears inside outer ──────────────────────────────────
    // Query nested ask-agent-tool descendant of the outer card.
    const innerLinked = outerCard.locator('[data-testid="ask-agent-tool"][data-child-task-id]');
    await expect(innerLinked).toBeVisible({ timeout: 30_000 });
    const innerChildId = await innerLinked.getAttribute("data-child-task-id");
    expect(innerChildId).not.toBe(outerChildId);
    const innerCard = outerCard
      .locator(`[data-testid="ask-agent-tool"][data-child-task-id="${innerChildId}"]`);
    await expect(innerCard).toHaveAttribute("data-state", "WORKING", { timeout: 10_000 });
    await expect(innerCard).toHaveAttribute("data-expanded", "true");

    // ── Inner d-chunk-1 streams live while WORKING (depth-2 token routing) ─
    await expect(innerCard).toContainText("d-chunk-1", { timeout: 10_000 });

    // ── Outer completes after journaler resume → COMPLETED + summary ─────
    // Note: by the time outer reaches COMPLETED, it auto-collapses and the
    // inner card unmounts from DOM (NestedThread renders only when expanded).
    // The inner card's COMPLETED transition is therefore not asserted via
    // the live UI — it's covered by the reload-replay spec where the rebuilt
    // child stream reflects terminal state. The nested spec's contract here
    // is: outer card auto-collapses after journaler completes (which it can
    // only do once deep terminates and journaler resumes to terminal).
    await expect(outerCard).toHaveAttribute("data-state", "COMPLETED", { timeout: 60_000 });
    await expect(outerCard).toHaveAttribute("data-expanded", "false");
    await expect(outerCard.locator('[data-testid="ask-agent-summary"]').first())
      .toHaveText(/^journaler answered: /, { timeout: 5_000 });

    // Drain inflight bridges (avoid dangling fetch noise on teardown).
    await Promise.allSettled(inflight);

    // VOS-107 T7 audit: lock the depth-2 contract at the DB boundary too.
    // The plan suggested asserting `data-subthread-depth >= 2` on a DOM
    // attribute; no such attribute exists in the product (AskAgentTool.tsx
    // only emits data-state/data-expanded/data-child-task-id). Nested DOM
    // structure already proves depth-2 visually, but to make the contract
    // resilient to future render refactors we additionally assert the
    // parent_task_id chain in the tasks table: root (maya) -> journaler
    // -> deep, three rows linked by parent_task_id forming a 3-deep chain.
    //
    // AUDIT note: do NOT add a data-subthread-depth attribute to product
    // code — DOM nesting + DB chain together are the contract.
    const outerChildIdFinal = outerChildId!;
    const dbR = new DatabaseSync(state.dbPath, { readOnly: true });
    try {
      const journaler = dbR
        .prepare("SELECT id, parent_task_id, target_agent FROM tasks WHERE id=?")
        .get(outerChildIdFinal) as { id: string; parent_task_id: string | null; target_agent: string };
      expect(journaler.target_agent).toBe("journaler");
      expect(journaler.parent_task_id).not.toBeNull();
      const root = dbR
        .prepare("SELECT id, parent_task_id FROM tasks WHERE id=?")
        .get(journaler.parent_task_id) as { id: string; parent_task_id: string | null };
      expect(root.parent_task_id).toBeNull();
      const deep = dbR
        .prepare("SELECT id, parent_task_id, target_agent FROM tasks WHERE parent_task_id=? AND target_agent='deep'")
        .get(journaler.id) as { id: string; parent_task_id: string; target_agent: string } | undefined;
      expect(deep, "depth-2 chain must include a 'deep' child of journaler").toBeTruthy();
      expect(deep!.parent_task_id).toBe(journaler.id);
    } finally { dbR.close(); }
  } finally {
    events.close();
    await browser.close();
  }
});
