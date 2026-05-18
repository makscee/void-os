// VOS-113 E2E: AgentList rail surface.
//
// Asserts:
//   1. Rail renders the AGENTS segment with both fixture agents (maya +
//      journaler) sorted alphabetically.
//   2. Clicking an agent row mints a new chat with that agent (no modal
//      appears) and the row gains data-active="true".
//   3. The existing modal `+ New` flow is untouched (we don't re-cover it
//      here; agent-picker.spec.ts owns that).
//
// Selectors mirror AgentList.tsx: data-testid="agent-row" with
// data-agent-name + data-active attrs. Inlined CDP-connect helper
// follows the chat-roundtrip / agent-picker pattern.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { getVaultPage } from "../helpers/vault-page.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
}

test("agents list rail: lists agents alphabetically, click mints chat with that agent", async ({ request }) => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    // Precondition: plugin connected to daemon.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // Open chat view.
    await page.evaluate(() => {
      // @ts-ignore
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    const chatRoot = page.getByTestId("vos-chat-root");
    await expect(chatRoot).toBeVisible({ timeout: 10_000 });

    // Dismiss any first-launch modal.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // 1. Rail surface visible with both fixture agents, sorted alpha.
    const rail = page.getByTestId("agent-list");
    await expect(rail).toBeVisible({ timeout: 10_000 });

    const rows = page.getByTestId("agent-row");
    await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    const names = await rows.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getAttribute("data-agent-name") ?? ""),
    );
    // Fixture: journaler + maya. Sort: case-insensitive alpha.
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    expect(names).toEqual(sorted);
    expect(names).toContain("maya");
    expect(names).toContain("journaler");

    // 2. Snapshot existing chats.
    const beforeRes = await request.get(`http://127.0.0.1:${state.port}/chats`);
    expect(beforeRes.status()).toBe(200);
    const beforeBody = (await beforeRes.json()) as Array<{ id: string }>;
    const beforeIds = new Set(beforeBody.map((c) => c.id));

    // 3. Click the "journaler" row.
    const journalerRow = page.locator("[data-testid='agent-row'][data-agent-name='journaler']");
    await expect(journalerRow).toBeVisible({ timeout: 5_000 });
    await journalerRow.click({ force: true, timeout: 5_000 });

    // Assert no modal opens (the rail-click bypasses the picker).
    // The picker is Obsidian's SuggestModal — it renders `.prompt > input.prompt-input`.
    await page.waitForTimeout(300); // settle frame
    await expect(page.locator(".prompt input.prompt-input")).toHaveCount(0);

    // 4. Daemon API assertion: new chat with agent=journaler.
    let newChat: { id: string; agent?: string } | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await request.get(`http://127.0.0.1:${state.port}/chats`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as Array<{ id: string; agent?: string }>;
      newChat = body.find((c) => !beforeIds.has(c.id) && c.agent === "journaler");
      if (newChat) break;
      await page.waitForTimeout(200);
    }
    expect(newChat, "new chat with agent=journaler should appear after rail click").toBeDefined();

    // 5. Rail active marker tracks the click optimistically.
    await expect(journalerRow).toHaveAttribute("data-active", "true", { timeout: 5_000 });
    const mayaRow = page.locator("[data-testid='agent-row'][data-agent-name='maya']");
    await expect(mayaRow).toHaveAttribute("data-active", "false");
  } finally {
    await browser.close();
  }
});
