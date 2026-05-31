// tmux.test.ts — integration tests against real tmux (3.6a present).
import { test, expect, afterEach } from "bun:test";
import { newRunSession, killSession, hasSession, attachCommand } from "../src/tmux.ts";

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

test("attachCommand returns the canonical attach string", () => {
  expect(attachCommand("vos-run-x")).toBe("tmux attach -t vos-run-x");
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
