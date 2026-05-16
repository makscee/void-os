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
 * VOS-107 T11 — cost meter (surface S5).
 *
 * Asserts the cost pipeline end-to-end via the `main` Playwright project's
 * shared daemon:
 *   1. After a fake run completes with a usage-bearing assistant event,
 *      the chat's lifetime SUM(costs.cost_usd) (surfaced via GET /chats →
 *      `cost_usd`) is > 0.
 *   2. After a SECOND run on the same chat, the lifetime sum strictly
 *      increases (per-run / per-task cost increment).
 *   3. The sidebar CostMeter widget (`data-testid="cost-meter"`) renders.
 *
 * Per-day reset (`VOS_FAKE_NOW` clock injection) is NOT supported by the
 * daemon. The CostMeter component (plugin/src/chat/CostMeter.tsx) is also
 * still a static placeholder ($0.00 / $5.00 daily) — VOS-81 will swap in
 * live daily totals. Until then this spec only asserts the widget mounts
 * and is observable in the sidebar; we do NOT cross-check its text against
 * GET /cost/today. Stretch acceptance only per plan.
 *
 * Provider wiring reality (mirrors chat-list-polish.spec.ts §"Provider
 * wiring reality"): the top-level orchestrator is constructed once with
 * `agent: "maya"`, so `resolveFakeScript` always reads
 * `VOS_FAKE_SCRIPT_maya` for any top-level chat dispatch. The shared
 * daemon's pinned maya script is `fixtures/ask-agent/maya.jsonl` (no
 * usage block → cost stays 0). We snapshot+restore that path so sibling
 * specs (ask-agent*, chat-roundtrip, chat-list-polish) remain unaffected;
 * Playwright `workers: 1` makes the snapshot/restore race-free.
 *
 * API shapes (per T9 findings, see ask-user.spec.ts header):
 *   POST /chats          {agent: "maya"}      (NOT agent_name)
 *   POST /chat/:id/message {text: "..."}     (NOT content)
 *   GET  /chats          → [{id, cost_usd, ...}]
 *
 * Field is `cost_usd`, not `cost` (plugin/src/chat/api.ts:43).
 */

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
  tmpdir: string;
  dbPath: string;
}

function loadState(): E2EState {
  return JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8"));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAYA_SCRIPT = path.join(HERE, "..", "fixtures", "ask-agent", "maya.jsonl");

async function getVaultPage(cdpPort: number): Promise<{ browser: Browser; page: Page }> {
  // Inlined per harness convention (no shared helpers module); see
  // chat-roundtrip.spec.ts and ask-user.spec.ts for prior art.
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
  // POST /chat/:id/message blocks until orchestrator.dispatch drains
  // run.end — by the time it returns, the cost subscriber has already
  // written a costs row (subscribeRunEnd runs synchronously on bus emit
  // and the fake provider emits run.end immediately after the script
  // exits cleanly). Awaiting is the right shape here because no part of
  // this fixture parks on vos_ask_user.
  const res = await api.post(`/chat/${chatId}/message`, { data: { text } });
  expect([200, 201, 202]).toContain(res.status());
}

async function getChatCostUsd(
  api: APIRequestContext,
  chatId: string,
): Promise<number> {
  const res = await api.get("/chats");
  expect(res.status()).toBe(200);
  const rows = (await res.json()) as Array<{ id: string; cost_usd?: number }>;
  const row = rows.find((r) => r.id === chatId);
  expect(row, `chat ${chatId} missing from GET /chats`).toBeTruthy();
  return row?.cost_usd ?? 0;
}

test.describe("VOS-107 T11 cost meter", () => {
  test.setTimeout(180_000);

  // Snapshot maya's pinned fake-script so the per-test mutation restores
  // cleanly for sibling specs (ask-agent*, chat-roundtrip, chat-list-polish).
  let originalMaya = "";
  test.beforeEach(() => {
    originalMaya = readFileSync(MAYA_SCRIPT, "utf8");
  });
  test.afterEach(() => {
    writeFileSync(MAYA_SCRIPT, originalMaya);
  });

  test("cost meter increments per task and the sidebar widget renders", async () => {
    const state = loadState();

    // Plant a usage-bearing assistant event on maya's pinned path.
    // claude-sonnet-4-6 priced 3e-6 input / 15e-6 output per token:
    //   5000 in + 200 out → ~$0.018 per run; second run doubles to ~$0.036.
    // `result` line is the CC stream-json end-of-turn sentinel; the fake
    // provider doesn't act on it but chat-list-polish plants it too — kept
    // for fixture symmetry.
    const jsonl = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "e2e-cost-meter" }),
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

    const { page, browser } = await getVaultPage(state.cdpPort);
    await openChatView(page);

    const api = await request.newContext({
      baseURL: `http://127.0.0.1:${state.port}`,
    });
    try {
      const chatId = await mintChatViaApi(api, "maya");

      // ── Run 1 ─────────────────────────────────────────────────────
      await sendMessageViaApi(api, chatId, "one");
      // Poll: bus → cost subscriber → INSERT into costs is synchronous on
      // run.end, but the chats-list SUM read may briefly see 0 if the
      // POST returns before the WS broadcast settles. A tight poll covers
      // the gap without flaking.
      await expect.poll(
        async () => await getChatCostUsd(api, chatId),
        { timeout: 15_000, intervals: [100, 250, 500] },
      ).toBeGreaterThan(0);
      const cost1 = await getChatCostUsd(api, chatId);
      expect(cost1).toBeGreaterThan(0);

      // ── Run 2 ─────────────────────────────────────────────────────
      await sendMessageViaApi(api, chatId, "two");
      await expect.poll(
        async () => await getChatCostUsd(api, chatId),
        { timeout: 15_000, intervals: [100, 250, 500] },
      ).toBeGreaterThan(cost1);
      const cost2 = await getChatCostUsd(api, chatId);
      expect(cost2).toBeGreaterThan(cost1);

      // ── Per-day surface ───────────────────────────────────────────
      // The CostMeter sidebar widget (plugin/src/chat/CostMeter.tsx) is a
      // VOS-80 placeholder — text is hard-coded "$0.00 / $5.00 daily" until
      // VOS-81 wires it to GET /cost/today. We assert the widget mounts
      // and is observable; do NOT cross-check the digits against the
      // ledger (would tightly couple this spec to placeholder text).
      const meter = page.getByTestId("cost-meter");
      await expect(meter).toBeVisible({ timeout: 10_000 });
      await expect(meter).toContainText(/\d/);
    } finally {
      await api.dispose();
      await browser.close();
    }
  });
});
