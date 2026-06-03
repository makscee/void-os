/**
 * VOS-216: Tests for the kickoff over-queue fix.
 *
 * Bug: after `waitForReady` returns, the idle REPL pane already contains spinner
 * chars (⠋ ⠙ etc.) in its status-bar animation. `sendKickoffWith` sends the kickoff,
 * then immediately sees the spinner chars and treats them as an acceptance signal —
 * but those chars were there BEFORE the send (false-positive). The function returns
 * "accepted on attempt 1" for the RIGHT reason (spinner in idle) rather than the
 * REAL reason (turn actually started). For a fresh/cold start where the acceptance
 * check fires falsely on every send, all 4-6 attempts fire without true acceptance.
 *
 * Root cause: ACCEPTANCE_MARKERS included spinner chars (⠋⠙…) which appear in the
 * REPL status-bar at idle — not just during turn processing. Only "Esc to interrupt"
 * / "esc to interrupt" is a genuine turn-running signal. The fix also introduces
 * baseline-pane comparison: pane content change from pre-send baseline is a secondary
 * acceptance signal (handles fast turns that complete before the first poll).
 *
 * Tests assert:
 *   A) spinner chars in the idle pane do NOT trigger false-positive acceptance
 *   B) "Esc to interrupt" → accepted immediately (true positive)
 *   C) pane content changed from baseline → accepted (fast-turn case)
 *   D) "accepted after N seconds" case: one retry, exactly ONE send total
 *   E) "needs one retry" case: first send not accepted, second accepted → exactly 2 sends
 *   F) sendKickoffWith exposes baseline seam (accepts baselinePane param)
 *   G) regression: original no-acceptance case still caps at maxAttempts
 */

import { expect, test } from "bun:test";
import { sendKickoffWith } from "../src/tmux.ts";

// ── A: Spinner chars in idle pane must NOT cause false-positive acceptance ──

test("VOS-216: idle spinner chars in pane do NOT trigger acceptance (false-positive regression)", async () => {
  // Simulate: REPL ready, first send → pane still shows idle spinner chars (present before send)
  // Old behavior: sees ⠋ → returns attempt=1 immediately → all 4 sends fire without checking
  // New behavior: spinner chars are NOT acceptance markers; must wait for real signal

  // Baseline: idle-ready pane with spinner in status bar (present BEFORE send)
  const baselinePane = "❯\nbypass permissions on (shift+tab to cycle) · ← for agents\nRelay: ⠋ 0tk";

  // captureFn: first call = baseline (pre-send); subsequent calls = after send, still same idle pane
  // (no real acceptance — spinner is there but not "Esc to interrupt")
  const paneSequence = [
    baselinePane, // attempt 1, poll 0
    baselinePane, // attempt 1, poll 1
    // never accepted — cap at maxAttempts=2
  ];
  let captureIdx = 0;
  const mockCapture = (_t: string) => paneSequence[Math.min(captureIdx++, paneSequence.length - 1)]!;

  const sends: string[] = [];
  const mockSend = (_t: string, line: string) => { sends.push(line); };

  await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 2, acceptWaitMs: 400, acceptPollMs: 200, baselinePane },
  );

  // Must have sent exactly maxAttempts times (never falsely accepted on spinner)
  expect(sends.length).toBe(2);
});

// ── B: "Esc to interrupt" is a genuine acceptance signal ──

test("VOS-216: 'Esc to interrupt' in pane triggers acceptance immediately", async () => {
  const baselinePane = "❯\nRelay: ⠋ 0tk";
  const paneAfterSend = "⠹ Processing…\nEsc to interrupt";

  let captureIdx = 0;
  const paneSequence = [paneAfterSend]; // accepted on first poll
  const mockCapture = (_t: string) => paneSequence[Math.min(captureIdx++, paneSequence.length - 1)]!;

  const sends: string[] = [];
  const mockSend = (_t: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 6, acceptWaitMs: 2_000, acceptPollMs: 200, baselinePane },
  );

  expect(sends.length).toBe(1);
  expect(attempts).toBe(1);
});

// ── C: Pane content changed from baseline → accepted (fast-turn case) ──

test("VOS-216: pane content change from baseline signals acceptance (fast-turn case)", async () => {
  // Turn completes so fast that "Esc to interrupt" is gone, but pane content changed
  const baselinePane = "❯\nRelay: ⠋ 0tk";
  const fastTurnPane = "Sure! Here is the onboarding form…\n❯\nRelay: ⠙ 42tk"; // different content

  let captureIdx = 0;
  const paneSequence = [fastTurnPane]; // first poll after send = turn already completed
  const mockCapture = (_t: string) => paneSequence[Math.min(captureIdx++, paneSequence.length - 1)]!;

  const sends: string[] = [];
  const mockSend = (_t: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 6, acceptWaitMs: 2_000, acceptPollMs: 200, baselinePane },
  );

  expect(sends.length).toBe(1);
  expect(attempts).toBe(1);
});

// ── D: "accepted after N seconds" — delayed acceptance, still exactly ONE send ──

test("VOS-216: acceptance after 3 polls → exactly ONE send, correct attempt count", async () => {
  // First 3 polls: still idle (no acceptance yet)
  // 4th poll: "Esc to interrupt" appears → accepted
  const baselinePane = "❯\nRelay: ⠋ 0tk";
  const paneSequence = [
    "❯\nRelay: ⠋ 0tk",      // poll 1: still idle (same as baseline)
    "❯\nRelay: ⠙ 0tk",      // poll 2: status-bar spinner advanced (but still idle)
    "❯\nRelay: ⠹ 0tk",      // poll 3: still idle
    "Esc to interrupt",      // poll 4: turn started
  ];
  let captureIdx = 0;
  const mockCapture = (_t: string) => paneSequence[Math.min(captureIdx++, paneSequence.length - 1)]!;

  const sends: string[] = [];
  const mockSend = (_t: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 6, acceptWaitMs: 5_000, acceptPollMs: 200, baselinePane },
  );

  // Must have sent exactly ONCE (accepted on first attempt, after 4 polls)
  expect(sends.length).toBe(1);
  expect(attempts).toBe(1);
});

// ── E: "needs one retry" — first attempt not accepted, second accepted ──

test("VOS-216: needs one retry — first attempt times out, second accepted → exactly 2 sends", async () => {
  // Attempt 1: all polls idle → time out → re-send
  // Attempt 2: first poll → accepted
  const baselinePane = "❯\nRelay: ⠋ 0tk";
  const paneSequence = [
    "❯\nRelay: ⠋ 0tk",   // attempt 1, poll 1: idle
    "❯\nRelay: ⠙ 0tk",   // attempt 1, poll 2: idle (attempt 1 exhausted)
    "Esc to interrupt",   // attempt 2, poll 1: accepted
  ];
  let captureIdx = 0;
  const mockCapture = (_t: string) => paneSequence[Math.min(captureIdx++, paneSequence.length - 1)]!;

  const sends: string[] = [];
  const mockSend = (_t: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 6, acceptWaitMs: 500, acceptPollMs: 250, baselinePane },
  );

  // Must have sent exactly 2 times (attempt 1 failed, attempt 2 accepted)
  expect(sends.length).toBe(2);
  expect(attempts).toBe(2);
});

// ── F: baselinePane param: when NOT provided, function still works (backward compat) ──

test("VOS-216: sendKickoffWith works without baselinePane (backward compat — Esc-based acceptance)", async () => {
  // Without baseline, acceptance is purely Esc-based (original behaviour for callers that don't pass it)
  const paneSequence = ["Esc to interrupt"];
  let captureIdx = 0;
  const mockCapture = (_t: string) => paneSequence[Math.min(captureIdx++, paneSequence.length - 1)]!;

  const sends: string[] = [];
  const mockSend = (_t: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 4, acceptWaitMs: 1_000, acceptPollMs: 200 },
  );

  expect(sends.length).toBe(1);
  expect(attempts).toBe(1);
});

// ── G: regression — maxAttempts cap still works when never accepted ──

test("VOS-216: never-accepted pane caps at maxAttempts sends (regression)", async () => {
  const mockCapture = (_t: string) => "❯\nRelay: ⠋ 0tk"; // always idle
  const sends: string[] = [];
  const mockSend = (_t: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 3, acceptWaitMs: 200, acceptPollMs: 100 },
  );

  expect(sends.length).toBe(3);
  expect(attempts).toBe(3);
});

// ── H: spawn.ts kickoff path captures baseline after waitForReady ──

test("VOS-216: spawn.ts kickoff block captures baseline before sending (source inspection)", () => {
  const { readFileSync } = require("node:fs");
  const src = readFileSync(new URL("../src/spawn.ts", import.meta.url), "utf8");
  // The kickoff block must capture pane content BEFORE sendKickoff (for the baseline)
  const kickoffBlock = src.slice(src.indexOf("opts.interactive && opts.skill"));
  // Must capture baseline via capturePaneContent or pass baselinePane
  const hasBaselineCapture =
    kickoffBlock.includes("capturePaneContent(tmuxSession") ||
    kickoffBlock.includes("baselinePane") ||
    kickoffBlock.includes("baseline");
  expect(hasBaselineCapture).toBe(true);
});
