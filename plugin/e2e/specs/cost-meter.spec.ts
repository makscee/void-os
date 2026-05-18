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
 * VOS-110 — Chat list shows context tokens; CostMeter shows daily 4-token
 * split fetched from /cost/today.
 *
 * Asserts:
 *   1. /chats payload exposes `context_tokens` (latest-turn sum) > 0 after
 *      a run lands a costs row.
 *   2. /cost/today total strictly increases between runs (proves a new
 *      costs row landed, not just that the chat-level field updated).
 *   3. CostMeter rendered text matches `<n>k? in / <n>k? out / <n>k? cc /
 *      <n>k? cr` once at least one run has landed today.
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
 *   GET  /chats          → [{id, context_tokens, ...}]
 *   GET  /cost/today     → { total: { input_tokens, output_tokens,
 *                                     cache_create_tokens,
 *                                     cache_read_tokens } }
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

async function getChatContextTokens(
  api: APIRequestContext,
  chatId: string,
): Promise<number> {
  const res = await api.get("/chats");
  expect(res.status()).toBe(200);
  const rows = (await res.json()) as Array<{ id: string; context_tokens?: number | null }>;
  const row = rows.find((r) => r.id === chatId);
  expect(row, `chat ${chatId} missing from GET /chats`).toBeTruthy();
  return typeof row?.context_tokens === "number" ? row.context_tokens : 0;
}

async function getCostTodayTotalTokens(api: APIRequestContext): Promise<number> {
  const res = await api.get("/cost/today");
  expect(res.status()).toBe(200);
  const json = (await res.json()) as { total?: Record<string, unknown> };
  const t = json?.total ?? {};
  const n = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  return (
    n(t.input_tokens) +
    n(t.output_tokens) +
    n(t.cache_create_tokens) +
    n(t.cache_read_tokens)
  );
}

test.describe("VOS-110 token meter", () => {
  test.setTimeout(180_000);

  test("context_tokens populates per chat and /cost/today total grows across runs; meter renders 4-token split", async () => {
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

    await withFixtureSwap(MAYA_SCRIPT, jsonl, async () => {
      const { page, browser } = await getVaultPage(state.cdpPort);
      await openChatView(page);

      const api = await request.newContext({
        baseURL: `http://127.0.0.1:${state.port}`,
      });
      try {
        const { chatId } = await mintChat(api, "maya");

        // ── Run 1 ─────────────────────────────────────────────────────
        // Snapshot /cost/today total BEFORE the first run so the cumulative
        // assertion proves a new costs row landed (not just that some
        // earlier run already pushed the total above zero).
        const totalBefore1 = await getCostTodayTotalTokens(api);
        await sendMessage(api, chatId, "one");

        // Per-chat: latest-turn context size > 0 (proves T2/T3 daemon-side
        // LEFT JOIN exposes the costs row's token sum).
        await expect.poll(
          async () => await getChatContextTokens(api, chatId),
          { timeout: 15_000, intervals: [100, 250, 500] },
        ).toBeGreaterThan(0);

        // Cumulative: /cost/today total strictly grew (proves the costs row
        // was inserted today, not pre-existing).
        await expect.poll(
          async () => await getCostTodayTotalTokens(api),
          { timeout: 15_000, intervals: [100, 250, 500] },
        ).toBeGreaterThan(totalBefore1);

        const ctx1 = await getChatContextTokens(api, chatId);
        const totalAfter1 = await getCostTodayTotalTokens(api);
        expect(ctx1).toBeGreaterThan(0);
        expect(totalAfter1).toBeGreaterThan(totalBefore1);

        // ── Run 2 ─────────────────────────────────────────────────────
        // Per-turn context (ctx2) is per-latest-row, not cumulative — it
        // may equal ctx1 since the planted fixture is identical. The strict
        // monotonicity claim belongs to /cost/today, not to context_tokens.
        await sendMessage(api, chatId, "two");
        await expect.poll(
          async () => await getCostTodayTotalTokens(api),
          { timeout: 15_000, intervals: [100, 250, 500] },
        ).toBeGreaterThan(totalAfter1);

        const ctx2 = await getChatContextTokens(api, chatId);
        expect(ctx2).toBeGreaterThan(0);

        // ── Meter shape ───────────────────────────────────────────────
        // After at least one run landed today, the CostMeter widget must
        // render the 4-token split `<n>k? in / <n>k? out / <n>k? cc /
        // <n>k? cr`. Gating on the digit-bearing regex prevents the spec
        // flaking on the cold-start loading text `— in / — out / — cc /
        // — cr`, which does NOT contain a digit before `in`.
        const meter = page.getByTestId("cost-meter");
        await expect(meter).toBeVisible({ timeout: 10_000 });
        await expect.poll(
          async () => {
            const text = await meter.innerText();
            return (
              /\d+(\.\d+)?k? in/.test(text) &&
              /out/.test(text) &&
              /cc/.test(text) &&
              /cr/.test(text)
            );
          },
          { timeout: 15_000, intervals: [100, 250, 500] },
        ).toBe(true);
      } finally {
        await api.dispose();
        await browser.close();
      }
    });
  });
});
