import {
  test,
  expect,
  chromium,
  request,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VOS-104 T8 — chat list polish e2e.
 *
 * Two scenarios:
 *   1. Amber dot ("input-required-dot") on a ChatList row appears while an
 *      ask_user prompt is open and clears (visibility: hidden — T6 keeps
 *      the slot via `vos:invisible`, does not remove the node) on answer.
 *   2. Cost cell ("cost-cell") reflects the daemon's cost ledger after a
 *      run completes (cross-checked against GET /cost/today).
 *
 * Provider wiring reality (daemon/src/app.ts):
 *   The top-level orchestrator is constructed once with `agent: "maya"`,
 *   so `resolveFakeScript` always reads `VOS_FAKE_SCRIPT_maya` for any
 *   chat dispatch — regardless of the chat's stored agent_name. The
 *   per-agent fake-script env vars (journaler / deep) only feed child
 *   dispatches via ask_agent.
 *
 *   Consequence: there is no way to drive a top-level vos_ask_user
 *   without overwriting `ASK_AGENT_MAYA_SCRIPT` (the file pinned at
 *   daemon start via VOS_FAKE_SCRIPT_maya). Each test snapshots the
 *   original maya fixture and restores it in afterEach so sibling
 *   specs (ask-agent, ask-agent-subthread, ask-agent-nested,
 *   ask-agent-reload) that rely on the depth-1 ask_agent flow are not
 *   disturbed. Playwright config pins workers=1 so the snapshot/restore
 *   is race-free.
 *
 * Chat minting is REST-driven (POST /chats, POST /chat/:id/message) to
 * avoid the agent-picker harness quirks; the chat-roundtrip and
 * ask-user specs already cover the picker path.
 */

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
  tmpdir: string;
  journalerActivePath: string;
  deepActivePath: string;
}

function loadState(): E2EState {
  return JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8"));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAYA_SCRIPT = path.join(HERE, "..", "fixtures", "ask-agent", "maya.jsonl");

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

/** Open the chat view (no agent picker / no chat mint). Used only so the
 *  ChatList sidebar is rendered and observable. */
async function openChatView(page: Page) {
  await expect(page.getByTestId("vos-status-bar"))
    .toHaveText("void-os: connected", { timeout: 20_000 });
  await page.evaluate(() => {
    // @ts-ignore — Obsidian renderer global.
    window.app.commands.executeCommandById("void-os:open-chat-view");
  });
  await expect(page.getByTestId("vos-chat-root")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

async function mintChatViaApi(api: APIRequestContext, agent: string): Promise<string> {
  const res = await api.post("/chats", { data: { agent } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBeTruthy();
  return body.id;
}

async function sendMessageViaApi(
  api: APIRequestContext,
  chatId: string,
  text: string,
): Promise<void> {
  const res = await api.post(`/chat/${chatId}/message`, { data: { text } });
  expect([200, 201, 202]).toContain(res.status());
}

function formatExpectedUsd(n: number): string {
  if (n < 0.005) return "$0.00";
  return "$" + n.toFixed(2);
}

test.describe("VOS-104 chat list polish", () => {
  test.setTimeout(120_000);

  // Snapshot maya's pinned fake-script so each test can restore the
  // original ask_agent depth-1 fixture for sibling specs.
  let originalMaya = "";
  test.beforeEach(() => {
    originalMaya = readFileSync(MAYA_SCRIPT, "utf8");
  });
  test.afterEach(() => {
    writeFileSync(MAYA_SCRIPT, originalMaya);
  });

  test("amber dot appears on ask_user open and clears on answer", async () => {
    const state = loadState();

    // Plant a vos_ask_user-driven fixture on maya's pinned path. We emit
    // a small assistant pre-text BEFORE the vos_ask_user directive so the
    // chat row has a non-empty `last_msg` and is not filtered by
    // ChatList's `isEmpty` predicate (which would hide the row and make
    // the dot unobservable). The ask-with-options.jsonl bundled in
    // fixtures/cc/ goes straight to vos_ask_user with no prior text.
    const askJsonl = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "e2e-dot" }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "thinking..." }],
        },
      }),
      JSON.stringify({
        type: "vos_ask_user",
        question: "Pick a color",
        options: ["red", "blue"],
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "chose ${answer}" }],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ].join("\n") + "\n";
    writeFileSync(MAYA_SCRIPT, askJsonl);

    const { page: p } = await getVaultPage(state.cdpPort);
    await openChatView(p);

    const api = await request.newContext({
      baseURL: `http://127.0.0.1:${state.port}`,
    });
    try {
      const chatId = await mintChatViaApi(api, "maya");
      await sendMessageViaApi(api, chatId, "go");

      const row = p.locator(`[data-testid='chat-row'][data-chat-id='${chatId}']`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const dot = row.locator(`[data-testid='input-required-dot']`);

      // Wait for the dot to become visible. T1+T2 set input_required
      // once the chat.task row flips to TASK_STATE_INPUT_REQUIRED; T7
      // refreshes ChatList on chat.task.state_changed.
      await expect.poll(
        async () => dot.evaluate((el) => getComputedStyle(el).visibility),
        { timeout: 30_000, intervals: [200, 500, 1000] },
      ).toBe("visible");
      const bg = await dot.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");
      expect(bg).not.toBe("transparent");

      // Resolve the prompt via direct POST. The in-thread banner-clear
      // path is already covered by ask-user.spec — here we only assert
      // the sidebar dot clears.
      const msgsRes = await api.get(`/chat/${chatId}/messages`);
      const messages = (await msgsRes.json()) as Array<{
        role: string;
        tool_call_id?: string;
        name?: string;
      }>;
      const askUseRow = [...messages]
        .reverse()
        .find((m) => m.role === "tool_use" && m.name === "ask_user");
      expect(askUseRow?.tool_call_id).toBeTruthy();
      const ansRes = await api.post(`/chat/${chatId}/answer`, {
        data: { tool_use_id: askUseRow!.tool_call_id, answer: "red" },
      });
      expect(ansRes.status()).toBe(200);

      // Dot becomes invisible (T6 keeps the slot via `vos:invisible`).
      await expect.poll(
        async () => dot.evaluate((el) => getComputedStyle(el).visibility),
        { timeout: 15_000, intervals: [200, 500, 1000] },
      ).toBe("hidden");
    } finally {
      await api.dispose();
    }
  });

  test("cost cell reflects ledger after a run completes", async () => {
    const state = loadState();

    // Plant a usage-bearing assistant event on maya's pinned path so the
    // cost pipeline writes a non-zero row at run.end. Model =
    // claude-sonnet-4-6 (3e-6 input / 15e-6 output per token → 5000 in
    // + 200 out ≈ $0.018, formats as "$0.02").
    const jsonl = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "e2e-cost" }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5000, output_tokens: 200 },
          content: [{ type: "text", text: "cost reply" }],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ].join("\n") + "\n";
    writeFileSync(MAYA_SCRIPT, jsonl);

    const { page: p } = await getVaultPage(state.cdpPort);
    await openChatView(p);

    const api = await request.newContext({
      baseURL: `http://127.0.0.1:${state.port}`,
    });
    try {
      const chatId = await mintChatViaApi(api, "maya");
      await sendMessageViaApi(api, chatId, "compute");

      const row = p.locator(`[data-testid='chat-row'][data-chat-id='${chatId}']`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const cell = row.locator(`[data-testid='cost-cell']`);

      // Poll the cell until it stops reading $0.00 — gated by run.end →
      // cost write → bus refresh round-trip + POLL_MS ceiling.
      await expect.poll(
        async () => (await cell.textContent()) ?? "",
        { timeout: 30_000, intervals: [200, 500, 1000] },
      ).not.toBe("$0.00");

      const ui = (await cell.textContent()) ?? "";
      expect(ui).toMatch(/^\$\d+\.\d{2}$/);

      // Cross-check against daemon truth.
      const costRes = await api.get("/cost/today");
      const json = (await costRes.json()) as {
        by_chat: Array<{ chat_id: string; usd: number }>;
      };
      const usd = json.by_chat.find((c) => c.chat_id === chatId)?.usd ?? 0;
      expect(ui).toBe(formatExpectedUsd(usd));
    } finally {
      await api.dispose();
    }
  });
});
