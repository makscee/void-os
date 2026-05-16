// VOS-91 T18: Playwright E2E for depth-1 ask_agent sub-thread.
//
// Two tests:
//   1. Live stream: AskAgentTool card appears WORKING+expanded while journaler
//      runs; auto-collapses to summary on COMPLETED.
//   2. Sticky toggle: manual click while WORKING collapses the card;
//      remains collapsed after COMPLETED (manual click overrides auto rule).
//
// Harness mirrors ask-agent.spec.ts: full daemon + Obsidian stack via
// VOS_E2E_STATE, WS bridge to call MCP ask_agent on behalf of the fake
// provider (same role a real claude-code subprocess plays in production).
//
// Fixtures (ask-agent-subthread/):
//   maya.jsonl     — text + ask_agent tool_use; no tool_result (bridge closes).
//   journaler.jsonl — chunk-1, chunk-2, noop tool_use, tool_result, final-answer-A.

import { test, expect, chromium, type Page, type Browser } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  waitForTaskRow,
  waitForTaskState,
  type TaskRow,
} from "../test-utils/wait-for-state.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  dbPath: string;
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

function openEventsWs(port: number): {
  ws: WebSocket;
  waitFor: (predicate: (msg: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
  const queue: Record<string, unknown>[] = [];
  const listeners: Array<(msg: Record<string, unknown>) => void> = [];
  ws.addEventListener("message", (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()) as Record<string, unknown>;
    } catch { return; }
    queue.push(msg);
    for (const l of listeners.splice(0)) l(msg);
  });
  return {
    ws,
    waitFor(predicate, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const hit = queue.find(predicate);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`waitFor: timeout after ${timeoutMs}ms`)), timeoutMs);
        const listener = (msg: Record<string, unknown>) => {
          if (predicate(msg)) {
            clearTimeout(t);
            resolve(msg);
          } else {
            listeners.push(listener);
          }
        };
        listeners.push(listener);
      });
    },
  };
}

async function callAskAgentOverMcp(args: {
  port: number;
  taskId: string;
  contextId: string;
  targetAgentId: string;
  message: string;
  toolCallId: string;
}): Promise<unknown> {
  const client = new Client({ name: "vos91-t18-spec", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${args.port}/mcp`),
  );
  await client.connect(transport);
  try {
    // VOS-97 ADR-0002: runtime ids travel via params._meta, not arguments.
    // tool_call_id must match the tool_use id from the WS frame so the
    // ask_agent handler can correlate parent_tool_call_id on mintChildAndFlipParent.
    return await client.callTool({
      name: "ask_agent",
      arguments: {
        target_agent_id: args.targetAgentId,
        message: args.message,
      },
      _meta: {
        task_id: args.taskId,
        context_id: args.contextId,
        tool_call_id: args.toolCallId,
      },
    });
  } finally {
    await client.close();
  }
}

/**
 * Open chat view, mint a new chat, send a message, set up the WS bridge.
 * Returns the events helper (bridge promise) and the chat root locator.
 */
async function setupChatAndBridge(
  page: Page,
  state: E2EState,
): Promise<{
  events: ReturnType<typeof openEventsWs>;
  askAgentResultPromise: Promise<unknown>;
  chatRoot: ReturnType<Page["getByTestId"]>;
}> {
  const events = openEventsWs(state.port);

  // Pre-open WS bridge BEFORE sending message so we don't miss chat.tool_use.
  const askAgentResultPromise = (async () => {
    const frame = await events.waitFor(
      (msg) => msg.type === "chat.tool_use" && msg.name === "ask_agent",
      30_000,
    );
    const chatId = String(frame.chat_id);
    const toolCallId = String(frame.tool_call_id ?? "");
    const input = frame.input as { target_agent_id?: string; message?: string };

    // Resolve parent task id; race-safe poll.
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
        } finally {
          dbR.close();
        }
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

  // Precondition: plugin connected.
  await expect(page.getByTestId("vos-status-bar"))
    .toHaveText("void-os: connected", { timeout: 20_000 });

  // Open chat view.
  await page.evaluate(() => {
    // @ts-ignore — app is Obsidian's global renderer.
    window.app.commands.executeCommandById("void-os:open-chat-view");
  });
  const chatRoot = page.getByTestId("vos-chat-root");
  await expect(chatRoot).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Mint a new chat. new-chat-btn opens an agent picker (SuggestModal);
  // click the first suggestion (maya) and wait for the picker to dismiss.
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

  return { events, askAgentResultPromise, chatRoot };
}

// ── Test 1: live stream → auto-collapse ─────────────────────────────────────

test("ask_agent sub-thread streams live then auto-collapses with summary", async () => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  const { events, askAgentResultPromise, chatRoot } = await setupChatAndBridge(page, state);

  try {
    // The ask_agent card should appear while journaler is running.
    // Use first() to handle edge-case where a prior test's card is still in DOM.
    const anyCard = chatRoot.locator('[data-testid="ask-agent-tool"]').first();
    await expect(anyCard).toBeVisible({ timeout: 10_000 });

    // Wait for the child stream to link: the real card gets data-child-task-id
    // once chat.child_task_started arrives (set by the MCP bridge roundtrip).
    const linkedCard = chatRoot.locator('[data-testid="ask-agent-tool"][data-child-task-id]');
    await expect(linkedCard).toBeVisible({ timeout: 20_000 });

    // Capture child task ID for a stable selector through subsequent re-renders.
    // (maya re-runs after journaler completes, adding a second placeholder card.)
    const childTaskId = await linkedCard.getAttribute("data-child-task-id");
    const stableCard = chatRoot.locator(`[data-testid="ask-agent-tool"][data-child-task-id="${childTaskId}"]`);

    await expect(stableCard).toHaveAttribute("data-state", "WORKING");
    await expect(stableCard).toHaveAttribute("data-expanded", "true");

    // Child tokens visible in the expanded sub-thread while WORKING.
    // journaler.jsonl emits "chunk-1 " then "chunk-2 " with 200ms delay each.
    await expect(stableCard).toContainText("chunk-1", { timeout: 8_000 });
    await expect(stableCard).toContainText("chunk-2", { timeout: 8_000 });

    // Wait for the bridge to close the MCP roundtrip.
    await askAgentResultPromise;

    // After journaler COMPLETED the card auto-collapses.
    await expect(stableCard).toHaveAttribute("data-state", "COMPLETED", { timeout: 20_000 });
    await expect(stableCard).toHaveAttribute("data-expanded", "false");

    // Summary line follows the "<agent> answered: <text>" pattern.
    await expect(stableCard.locator('[data-testid="ask-agent-summary"]'))
      .toHaveText(/^journaler answered: /, { timeout: 5_000 });

    // Verify DB wiring: parent and child both COMPLETED.
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

    const child = await waitForTaskRow({
      dbPath: state.dbPath,
      contextId,
      predicate: (r: TaskRow) =>
        r.parent_task_id === parent.id && r.target_agent === "journaler",
      timeoutMs: 5_000,
    });
    await waitForTaskState({
      dbPath: state.dbPath,
      taskId: child.id,
      expected: "TASK_STATE_COMPLETED",
      timeoutMs: 5_000,
    });
  } finally {
    try { events.ws.close(); } catch { /* ignore */ }
    await browser.close();
  }
});

// ── Test 2: sticky toggle overrides auto-collapse ───────────────────────────

test("manual click while WORKING overrides auto-collapse (sticky)", async () => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  const { events, askAgentResultPromise, chatRoot } = await setupChatAndBridge(page, state);

  try {
    // Wait for the child stream to link before clicking toggle.
    // data-child-task-id is set once chat.child_task_started arrives.
    const linkedCard = chatRoot.locator('[data-testid="ask-agent-tool"][data-child-task-id]');
    await expect(linkedCard).toBeVisible({ timeout: 20_000 });

    // Capture child task ID for a stable selector through subsequent re-renders.
    const childTaskId = await linkedCard.getAttribute("data-child-task-id");
    const stableCard = chatRoot.locator(`[data-testid="ask-agent-tool"][data-child-task-id="${childTaskId}"]`);

    await expect(stableCard).toHaveAttribute("data-state", "WORKING");
    await expect(stableCard).toHaveAttribute("data-expanded", "true");

    // Click the toggle button while WORKING → should collapse.
    await stableCard.locator("button").first().click();
    await expect(stableCard).toHaveAttribute("data-expanded", "false");

    // Wait for journaler to complete.
    await askAgentResultPromise;

    // After COMPLETED, the manual click sticks: card stays collapsed.
    await expect(stableCard).toHaveAttribute("data-state", "COMPLETED", { timeout: 20_000 });
    await expect(stableCard).toHaveAttribute("data-expanded", "false");
  } finally {
    try { events.ws.close(); } catch { /* ignore */ }
    await browser.close();
  }
});
