// VOS-160 E2E: live in-flight agent inspector.
//
// Covers VOS-155 acceptance bullets surfaced through the InspectorView:
//   1. the inspector lists every in-flight agent (one row per agent_id)
//   2. clicking a row reveals its step-by-step trace (AgentEvent list)
//   5. the view refreshes automatically (<=2s poll) — no manual reload
//   6. the whole path is exercised end-to-end against a real daemon
//
// Method: drive a chat round-trip with the fake provider. The daemon's
// VOS-155 bridge translates the run's chat.token / task.state_changed /
// run.end frames into `agent.event`s; the inflight registry keeps the
// agent row (it lingers for a 10s grace window after the run ends). The
// inspector polls GET /agents/inflight and renders the row + trace.
//
// Selectors mirror agents/InspectorRoot.tsx:
//   data-testid="vos-inspector-root" | "inspector-agent-row" |
//   "inspector-trace" | "inspector-trace-event" | "inspector-empty"
//
// Harness traps heeded (workspace/void-os/CLAUDE.md): inline CDP via the
// getVaultPage helper; no new helpers; `force` clicks for Obsidian's
// bare-div surfaces; generous timeouts for the cold-cache Obsidian boot.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { getVaultPage } from "../helpers/vault-page.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
  dbPath: string;
  /** Per-run tmpdir; the daemon's bearer token lives at
   *  `${tmpdir}/home/.void-os/token` (globalSetup isolates HOME there). */
  tmpdir: string;
}

test("inspector view: lists in-flight agent, click expands its trace, auto-refreshes", async ({ request }) => {
  test.setTimeout(120_000);
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as E2EState;
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    // Precondition: plugin connected to daemon.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // ── Open the inspector via its command. Empty state renders first. ──
    await page.evaluate(() => {
      // @ts-ignore — `app` is Obsidian's global in the renderer.
      window.app.commands.executeCommandById("void-os:open-inspector-view");
    });
    const inspector = page.getByTestId("vos-inspector-root");
    await expect(inspector).toBeVisible({ timeout: 10_000 });

    // Dismiss any first-launch modal that stole focus.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // No agents dispatched yet → the empty-state copy is shown.
    await expect(page.getByTestId("inspector-empty")).toBeVisible({ timeout: 10_000 });

    // ── Dispatch a chat run so the daemon's bridge emits agent.events. ──
    // Mint + send directly over HTTP (the inspector is the surface under
    // test; the chat UI path is covered by chat-roundtrip.spec.ts).
    const mintRes = await request.post(`http://127.0.0.1:${state.port}/chats`, {
      data: { agent: "maya" },
    });
    expect(mintRes.status()).toBe(200);
    const chatId = ((await mintRes.json()) as { id: string }).id;

    const sendRes = await request.post(`http://127.0.0.1:${state.port}/chat/${chatId}/message`, {
      data: { text: "ping" },
    });
    expect([200, 201, 202]).toContain(sendRes.status());

    // ── Bullet 1 + 5: the agent row appears in the inspector WITHOUT a
    //    manual reload — proves the auto-refresh poll picked it up. ──
    const agentRow = page.getByTestId("inspector-agent-row").first();
    await expect(agentRow).toBeVisible({ timeout: 15_000 });

    // The row shows a task id and a phase label (running or ended).
    await expect(agentRow.getByTestId("inspector-agent-task")).not.toBeEmpty();
    await expect(agentRow.getByTestId("inspector-agent-phase")).not.toBeEmpty();

    // Trace is collapsed until clicked.
    await expect(page.getByTestId("inspector-trace")).toHaveCount(0);

    // ── Bullet 2: click the row → step-by-step trace expands. ──
    await agentRow.click({ force: true, timeout: 5_000 });
    await expect(agentRow).toHaveAttribute("data-expanded", "true", { timeout: 5_000 });

    const trace = page.getByTestId("inspector-trace");
    await expect(trace).toBeVisible({ timeout: 5_000 });

    // The trace lists at least one AgentEvent (the run produced token /
    // status / end frames; the bridge translated each into an event).
    const traceEvents = page.getByTestId("inspector-trace-event");
    await expect.poll(async () => traceEvents.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    // Every trace event carries a non-empty kind attribute.
    const kinds = await traceEvents.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getAttribute("data-kind") ?? ""),
    );
    expect(kinds.every((k) => k.length > 0)).toBe(true);

    // ── Clicking again collapses the trace. ──
    await agentRow.click({ force: true, timeout: 5_000 });
    await expect(agentRow).toHaveAttribute("data-expanded", "false", { timeout: 5_000 });
    await expect(page.getByTestId("inspector-trace")).toHaveCount(0);

    // ── VOS-161: verb routes mounted + bearer-auth gated; UI verb-bar
    //    gating. ──
    // The control-verb endpoints (POST /agents/:id/{pause,resume,kill})
    // back the inspector's intervention buttons. A control handle is
    // registered only by the child dispatcher (dispatch-child.ts), keyed by
    // childTaskId. The chat run above goes through the orchestrator, which
    // dispatches no child — so its agent row carries `control_state: null`
    // and the VerbBar gates itself off. That makes three things
    // deterministically assertable:
    //   (a) the verb endpoint rejects a tokenless request (auth gate), and
    //   (b) it returns a typed 404 for an unknown agent_id (route mounted), and
    //   (c) the inspector renders NO verb bar for a handle-less row — the
    //       VerbBar's `control_state===null` gating path.
    // Verb *behaviour* (pause-park-resume, kill→abort) and the rendered
    // verb-buttons path are covered by the daemon unit suite
    // (control.test.ts, run-driver onCheckpoint, agents-control.test.ts).

    // Auth-gated: a tokenless verb POST is rejected, never silently 200.
    const noAuth = await request.post(
      `http://127.0.0.1:${state.port}/agents/does-not-exist/kill`,
    );
    expect([401, 403]).toContain(noAuth.status());

    // Authenticated but unknown agent_id → typed 404 (route IS mounted).
    const daemonToken = readFileSync(
      `${state.tmpdir}/home/.void-os/token`,
      "utf8",
    ).trim();
    const unknown = await request.post(
      `http://127.0.0.1:${state.port}/agents/does-not-exist/kill`,
      { headers: { Authorization: `Bearer ${daemonToken}` } },
    );
    expect(unknown.status()).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });

    // UI: the orchestrator-run agent row carries no live control handle,
    // so the inspector renders no verb bar against it (the gating path).
    await expect(page.getByTestId("inspector-verb-bar")).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
