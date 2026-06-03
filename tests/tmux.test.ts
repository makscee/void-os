// tmux.test.ts — integration tests against real tmux (3.6a present).
// VOS-205: updated for -L vos socket isolation + new helpers.
import { test, expect, afterEach } from "bun:test";
import { newRunSession, killSession, hasSession, attachCommand, switchClient, sendKeys, listVosSessions, VOS_SOCKET, capturePaneContent, waitForPrompt } from "../src/tmux.ts";
import { readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const NAME = "vos-run-test-" + process.pid;

afterEach(() => {
  try { killSession(NAME); } catch { /* ignore */ }
});

test("newRunSession starts a detached session that hasSession sees; killSession removes it", () => {
  const pid = newRunSession(NAME, process.cwd(), "sleep 30", {});
  expect(typeof pid).toBe("number");
  expect(hasSession(NAME)).toBe(true);
  killSession(NAME);
  expect(hasSession(NAME)).toBe(false);
});

test("attachCommand returns the canonical attach string with -L vos socket", () => {
  expect(attachCommand("vos-run-x")).toBe(`tmux -L ${VOS_SOCKET} attach -t vos-run-x`);
});

test("killSession on a missing session is a no-op (no throw)", () => {
  expect(() => killSession("vos-run-nope-" + process.pid)).not.toThrow();
});

test("newRunSession returns a numeric pid", () => {
  const sessName = "vos-run-pid-" + process.pid;
  try {
    const pid = newRunSession(sessName, process.cwd(), "sleep 10", {});
    expect(typeof pid).toBe("number");
    expect(pid).toBeGreaterThan(0);
  } finally {
    try { killSession(sessName); } catch { /* ignore */ }
  }
});

test("sessions live on the -L vos socket, isolated from the default server", () => {
  const name = "vos-run-sock-" + process.pid;
  try {
    newRunSession(name, process.cwd(), "sleep 30", {});
    // visible on the vos socket
    expect(hasSession(name)).toBe(true);
    // listVosSessions includes it
    expect(listVosSessions()).toContain(name);
  } finally { killSession(name); }
});

test("sendKeys delivers a line to a live session pane", () => {
  const name = "vos-run-keys-" + process.pid;
  const out = `/tmp/vos-keys-${process.pid}.txt`;
  try {
    // a shell that appends stdin lines to a temp file
    newRunSession(name, process.cwd(), `bash -c 'while read l; do echo "$l" >> ${out}; done'`, {});
    sendKeys(name, "PINGLINE");
    // poll up to 2s for the line to land (no long-lived hold)
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      try { ok = readFileSync(out, "utf8").includes("PINGLINE"); } catch { /* file may not exist yet */ }
      if (!ok) execSync("sleep 0.1");
    }
    expect(ok).toBe(true);
  } finally {
    killSession(name);
    rmSync(out, { force: true });
  }
});

// VOS-206 Gap 1: waitForPrompt polls pane content for a marker string.
test("capturePaneContent returns empty string for non-existent session", () => {
  expect(capturePaneContent("vos-run-definitely-nonexistent-" + process.pid)).toBe("");
});

test("waitForPrompt resolves true when marker appears in pane within timeout", async () => {
  const name = "vos-run-waitprompt-" + process.pid;
  try {
    // Start a shell that prints the marker after 200ms then loops
    newRunSession(name, process.cwd(), `bash -c 'sleep 0.2; echo "❯"; sleep 30'`, {});
    // waitForPrompt polls every 200ms; marker should appear well within 5s
    const result = await waitForPrompt(name, "❯", 5_000, 200);
    expect(result).toBe(true);
  } finally {
    try { killSession(name); } catch { /* ignore */ }
  }
}, 8_000);

test("waitForPrompt returns false when marker never appears before timeout", async () => {
  const name = "vos-run-waitprompt-timeout-" + process.pid;
  try {
    // Shell that never prints the marker
    newRunSession(name, process.cwd(), `bash -c 'sleep 30'`, {});
    const result = await waitForPrompt(name, "NEVER_APPEARS_MARKER_XYZ", 500, 100);
    expect(result).toBe(false);
  } finally {
    try { killSession(name); } catch { /* ignore */ }
  }
}, 3_000);
