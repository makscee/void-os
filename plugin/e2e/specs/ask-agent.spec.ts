// VOS-89 T16: end-to-end Playwright spec for the ask_agent flow
// (maya -> journaler) driven through the real plugin UI + real daemon
// + real MCP server, with both agents backed by per-agent fake-provider
// scripts (set in globalSetup via VOS_FAKE_SCRIPT_<agent>).
//
// What this spec exercises end-to-end:
//   1. Plugin UI: open chat view, mint a chat (defaults to maya), send a
//      user message; the plugin POSTs /chat/:id/message which kicks the
//      orchestrator on the daemon side.
//   2. Daemon orchestrator: spawns the fake provider for maya, which
//      replays maya.jsonl (text + tool_use{ask_agent}). The orchestrator
//      surfaces chat.tool_use over /events.
//   3. Test bridge: the spec connects to ws://.../events and watches for
//      chat.tool_use{name:"ask_agent"}. When seen, it calls the daemon's
//      MCP server's `ask_agent` tool over Streamable HTTP — playing the
//      role that a real claude-code subprocess would play (the fake
//      provider does NOT loop back into MCP itself).
//   4. Daemon MCP ask_agent handler: mints child task + flips parent to
//      WAITING_ON_AGENT, then dispatches journaler via the production
//      makeDispatchChildTask. Journaler's fake provider drains
//      journaler.jsonl ("A"), child flips COMPLETED, parent resumes via
//      resumeParentOnChildTerminal -> WORKING -> COMPLETED.
//   5. Spec asserts:
//        - parent reached WAITING_ON_AGENT during the gap
//        - child reached COMPLETED
//        - parent reached COMPLETED
//        - child.parent_task_id === parent.id
//        - child.context_id === parent.context_id
//        - child.target_agent === "journaler"
//        - "A" rendered in the chat thread
//
// Schema notes (consistent with T15):
// - `tasks` has NO `agent_name` column. The plan's pollForTaskIds spec
//   said `WHERE agent_name='maya'`; that does not parse against the real
//   schema. We instead use `parent_task_id IS NULL` (root) + `target_agent`
//   for the child. Caller agent identity = contexts.agent_name.

import { test, expect, chromium, type Page, type Browser } from "@playwright/test";
import { readFileSync } from "node:fs";
// Playwright runs under Node, not Bun. Use node:sqlite (>=v22.5).
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

/**
 * Connect to the daemon's /events WebSocket. Returns the WS plus a queue
 * of frames + a Promise-returning waiter (`waitFor`) that resolves on the
 * first matching frame. Used to detect the chat.tool_use{ask_agent} signal
 * that triggers the test's MCP bridge call.
 */
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
        // First scan the queue for an already-arrived match.
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

/**
 * Issue a real MCP `ask_agent` tool call against the daemon. Mirrors the
 * pattern in daemon/test/integration/ask-agent.test.ts: one fresh
 * StreamableHTTPClientTransport per call (stateless mode).
 */
async function callAskAgentOverMcp(args: {
  port: number;
  taskId: string;
  contextId: string;
  targetAgentId: string;
  message: string;
  toolCallId: string;
}): Promise<unknown> {
  const client = new Client({ name: "vos89-t16-spec", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    // VOS-106 T8: /mcp requires ?agent=<name> for calling-agent identity.
    // The caller here is maya (parent dispatching ask_agent to a child).
    new URL(`http://127.0.0.1:${args.port}/mcp?agent=maya`),
  );
  await client.connect(transport);
  try {
    // VOS-97 ADR-0002: runtime ids travel via params._meta, not arguments.
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

test("ask_agent end-to-end: maya -> journaler via real MCP + plugin UI", async () => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  // Open WS bridge BEFORE we send the user message so we don't miss the
  // chat.tool_use frame. Bridges chat.tool_use{ask_agent} into the real
  // MCP `ask_agent` call (the role a CC subprocess plays in production).
  const events = openEventsWs(state.port);
  const askAgentResult = (async () => {
    const frame = await events.waitFor(
      (msg) => msg.type === "chat.tool_use" && msg.name === "ask_agent",
      30_000,
    );
    const chatId = String(frame.chat_id);
    const toolCallId = String(frame.tool_call_id ?? "");
    const input = frame.input as { target_agent_id?: string; message?: string };

    // Resolve the parent task id from the chat (= context) id. There is
    // exactly one root task per chat at this stage (parent_task_id IS NULL).
    // Tasks table is populated via WORKING flip after the chat message
    // POSTs to /chat/:id/message; race-prone when we read straight away.
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
      message: String(input.message ?? "summarise"),
      toolCallId,
    });
  })();

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
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Mint chat. new-chat-btn opens the agent picker (SuggestModal).
    // Click the first suggestion (maya) and wait for the picker to dismiss.
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

    // VOS-107 T5 audit: spec header comment (line 25) lists "parent reached
    // WAITING_ON_AGENT during the gap" as one of the five contract assertions
    // but the existing test bodies only checked the terminal COMPLETED state.
    // Sample the parent's state column while the MCP bridge is in flight and
    // record every distinct state seen; assert WAITING_ON_AGENT was observed.
    //
    // The sampler runs until either askAgentResult resolves (MCP roundtrip
    // returns) or until we see TASK_STATE_COMPLETED — whichever first. Tight
    // 25ms cadence catches the WAITING_ON_AGENT window which closes the
    // moment journaler terminates and resumeParentOnChildTerminal flips the
    // parent back to WORKING.
    const observedStates = new Set<string>();
    const sampler = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const db = new DatabaseSync(state.dbPath, { readOnly: true });
        try {
          const row = db
            .prepare(
              "SELECT id, state FROM tasks WHERE parent_task_id IS NULL ORDER BY created_at DESC LIMIT 1",
            )
            .get() as { id: string; state: string } | undefined;
          if (row?.state) {
            observedStates.add(row.state);
            if (row.state === "TASK_STATE_COMPLETED") return;
          }
        } finally { db.close(); }
        await new Promise((r) => setTimeout(r, 25));
      }
    })();

    // Wait for the bridge to observe + complete the MCP roundtrip.
    const askResult = (await askAgentResult) as {
      content: Array<{ type: string; text: string }>;
    };
    await sampler;
    expect(
      observedStates.has("TASK_STATE_WAITING_ON_AGENT"),
      `parent task must transit WAITING_ON_AGENT; observed: ${[...observedStates].join(",")}`,
    ).toBe(true);
    expect(askResult.content[0]!.type).toBe("text");
    // VOS-91 T18: journaler fixture updated to "final-answer-A"; toContain
    // remains true and also works with the original single-char fixture.
    expect(askResult.content[0]!.text).toContain("A");

    // Locate parent + child rows, then assert the state-machine progression.
    const parent = await waitForTaskRow({
      dbPath: state.dbPath,
      // Use the chat just created — the only root task with target_agent
      // null and a pending journaler child.
      contextId: await (async () => {
        const db = new DatabaseSync(state.dbPath, { readOnly: true });
        try {
          const row = db
            .prepare(
              "SELECT context_id FROM tasks WHERE parent_task_id IS NULL ORDER BY created_at DESC LIMIT 1",
            )
            .get() as { context_id: string };
          return row.context_id;
        } finally { db.close(); }
      })(),
      predicate: (r: TaskRow) => r.parent_task_id === null,
      timeoutMs: 10_000,
    });

    // Wait for parent to reach COMPLETED (path: WORKING -> WAITING_ON_AGENT
    // [during MCP roundtrip] -> WORKING [resume] -> COMPLETED [run.end-style
    // settle from resumeParentOnChildTerminal]).
    await waitForTaskState({
      dbPath: state.dbPath,
      taskId: parent.id,
      expected: "TASK_STATE_COMPLETED",
      timeoutMs: 15_000,
    });

    // Child: parent_task_id == parent.id, target_agent = journaler.
    const child = await waitForTaskRow({
      dbPath: state.dbPath,
      contextId: parent.context_id,
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

    // DB-level wiring assertions.
    expect(child.parent_task_id).toBe(parent.id);
    expect(child.context_id).toBe(parent.context_id);
    expect(child.target_agent).toBe("journaler");

    const dbR = new DatabaseSync(state.dbPath, { readOnly: true });
    try {
      const ctx = dbR
        .prepare("SELECT agent_name FROM contexts WHERE id=?")
        .get(parent.context_id) as { agent_name: string };
      expect(ctx.agent_name).toBe("maya");
    } finally {
      dbR.close();
    }

    // Final assistant text "A" visible in the thread. The journaler's
    // single text turn lives on the CHILD task's messages, not on the
    // parent chat's UI thread (the chat UI is bound to the parent task /
    // context). The user-visible text is therefore maya's own text turn
    // ("asking journaler... ") AND nothing further from the parent (its
    // post-tool turn is empty in the fake script). The "A" assertion is
    // satisfied at the DB level via the child.messages content. We assert
    // it from the messages table to keep the spec deterministic — the
    // chat UI doesn't render child-task messages today.
    const dbR2 = new DatabaseSync(state.dbPath, { readOnly: true });
    try {
      const msgs = dbR2
        .prepare(
          "SELECT parts_text FROM messages WHERE task_id=? AND role='ROLE_AGENT'",
        )
        .all(child.id) as Array<{ parts_text: string }>;
      const allText = msgs.map((m) => m.parts_text).join(" ");
      expect(allText).toContain("A");
    } finally {
      dbR2.close();
    }

    // Maya's narrative turn renders in the visible thread. The fixture
    // (maya.jsonl) emits a text segment "hello from fake" alongside the
    // ask_agent tool_use; the chat-roundtrip spec also relies on this
    // string. This shared text avoids splintering maya's e2e behavior.
    await expect(chatRoot.getByRole("paragraph").filter({ hasText: "hello from fake" }))
      .toBeVisible({ timeout: 10_000 });
  } finally {
    try { events.ws.close(); } catch { /* ignore */ }
    await browser.close();
  }
});
