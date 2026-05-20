import {
  test,
  expect,
  request,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getVaultPage } from "../helpers/vault-page.ts";
import { mintChat, sendMessage } from "../helpers/daemon-api.ts";
import { withFixtureSwap } from "../helpers/fixture-swap.ts";

/**
 * VOS-114 T6 — chat list polish e2e (migrated from VOS-104 T8).
 *
 * Two scenarios:
 *   1. Unified status dot (`chat-row-status` + `data-status`) replaces the
 *      old `input-required-dot` + trailing chip. Status transitions to
 *      "input_required" while an ask_user prompt is open and exits that
 *      state on answer.
 *   2. Row now surfaces `chat-row-agent` and `chat-row-time` on row 2.
 *      `context-cell` (tokens) replaces the old `cost-cell` and no longer
 *      carries a `title=` tooltip. Cross-check against GET /cost/today
 *      is kept — daemon ledger pipeline is healthy.
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

/**
 * Fire-and-forget variant. `POST /chat/:id/message` does NOT return until the
 * orchestrator's run.end fires (orchestrator.dispatch awaits the full for-await
 * drain of provider events before returning). Scenarios that pause mid-run on
 * `vos_ask_user` deadlock when the test awaits the POST: the answer POST never
 * gets issued, the run never ends, the message POST never returns.
 *
 * This helper kicks the POST off the event loop and returns immediately. The
 * caller is responsible for re-asserting through downstream side effects (chat
 * row appears, dot becomes visible, etc.). We attach a `.catch()` so a future
 * test failure doesn't surface as an unhandled-rejection during teardown.
 */
function fireMessageViaApi(
  api: APIRequestContext,
  chatId: string,
  text: string,
): Promise<unknown> {
  return api
    .post(`/chat/${chatId}/message`, { data: { text } })
    .catch(() => undefined);
}

test.describe("VOS-114 chat list polish", () => {
  test.setTimeout(120_000);

  test("status dot transitions to input_required on ask_user and clears on answer", async () => {
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

    await withFixtureSwap(MAYA_SCRIPT, askJsonl, async () => {
      const { page: p } = await getVaultPage(state.cdpPort);
      await openChatView(p);

      const api = await request.newContext({
        baseURL: `http://127.0.0.1:${state.port}`,
      });
      try {
        const { chatId } = await mintChat(api, "maya");
        // Fire-and-forget — orchestrator.dispatch blocks until run.end, and this
        // run parks on `vos_ask_user` until /answer is POSTed below. Awaiting
        // the message POST here would deadlock the test.
        const messagePromise = fireMessageViaApi(api, chatId, "go");

        // VOS-153 T8: ChatList row testid is now `chat-row-${id}` (was
        // bare `chat-row` keyed by `data-chat-id`). The `data-chat-id`
        // attr is still emitted so the parent selector retains semantic
        // anchoring; the testid is what's tightened.
        const row = p.locator(`[data-testid='chat-row-${chatId}']`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        const dot = row.locator(`[data-testid='chat-row-status']`);

        // Wait for the unified status dot to reach input_required. T1+T2 set
        // data-status once the chat.task row flips to TASK_STATE_INPUT_REQUIRED;
        // T7 refreshes ChatList on chat.task.state_changed.
        await expect.poll(
          async () => dot.evaluate((el) => (el as HTMLElement).dataset.status ?? ""),
          { timeout: 30_000, intervals: [200, 500, 1000] },
        ).toBe("input_required");

        // Resolve the prompt via direct POST. The in-thread banner-clear
        // path is already covered by ask-user.spec — here we only assert
        // the sidebar status clears.
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

        // Status exits input_required — may briefly be "running" then settle to "idle".
        await expect.poll(
          async () => dot.evaluate((el) => (el as HTMLElement).dataset.status ?? ""),
          { timeout: 30_000, intervals: [200, 500, 1000] },
        ).not.toBe("input_required");

        // Drain the fire-and-forget message POST so the fixture-swap restore
        // doesn't race with an in-flight orchestrator run.
        await messagePromise;
      } finally {
        await api.dispose();
      }
    });
  });

  test("row exposes agent badge, relative time, and tokens after a run completes", async () => {
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

    await withFixtureSwap(MAYA_SCRIPT, jsonl, async () => {
      const { page: p } = await getVaultPage(state.cdpPort);
      await openChatView(p);

      const api = await request.newContext({
        baseURL: `http://127.0.0.1:${state.port}`,
      });
      try {
        const { chatId } = await mintChat(api, "maya");
        await sendMessage(api, chatId, "compute");

        // VOS-153 T8: see comment in the first test above.
        const row = p.locator(`[data-testid='chat-row-${chatId}']`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        const tokensCell = row.locator(`[data-testid='context-cell']`);

        // Poll until context-cell shows a non-empty token count — gated by
        // run.end → cost write → bus refresh round-trip + POLL_MS ceiling.
        await expect.poll(
          async () => (await tokensCell.textContent()) ?? "",
          { timeout: 30_000, intervals: [200, 500, 1000] },
        ).toMatch(/\d/);

        const ui = (await tokensCell.textContent()) ?? "";
        expect(ui).toBeTruthy();

        // VOS-114: tooltip dropped — title attribute must be absent.
        const titleAttr = await tokensCell.getAttribute("title");
        expect(titleAttr).toBeNull();

        // Agent badge — all top-level chats are minted with agent: "maya".
        const badge = row.locator(`[data-testid='chat-row-agent']`);
        await expect(badge).toHaveText("maya");

        // Relative time — should mention a time unit after run completes.
        const timeEl = row.locator(`[data-testid='chat-row-time']`);
        await expect.poll(
          async () => (await timeEl.textContent()) ?? "",
          { timeout: 10_000 },
        ).toMatch(/(seconds|minute|hour|day)/);

        // Cross-check against daemon truth (ledger pipeline healthy).
        const costRes = await api.get("/cost/today");
        const json = (await costRes.json()) as {
          by_chat: Array<{ chat_id: string; usd: number }>;
        };
        const usd = json.by_chat.find((c) => c.chat_id === chatId)?.usd ?? 0;
        expect(usd).toBeGreaterThan(0);
      } finally {
        await api.dispose();
      }
    });
  });
});
