import { describe, test, expect, mock } from "bun:test";

// Stub the obsidian module's `moment` so bun can resolve it.
// We return a tiny moment-like that supports `.fromNow(true)` based on
// the diff from a fixed "now" injected via the global. This lets us
// assert label vocabulary without pulling in real moment.
const NOW = 1_700_000_000_000;
(globalThis as { __VOS_FAKE_NOW__?: number }).__VOS_FAKE_NOW__ = NOW;

mock.module("obsidian", () => ({
  moment(ts: number) {
    const now = (globalThis as { __VOS_FAKE_NOW__?: number }).__VOS_FAKE_NOW__ ?? Date.now();
    const diffSec = Math.round((now - ts) / 1000);
    return {
      fromNow(withoutSuffix?: boolean): string {
        const abs = Math.abs(diffSec);
        const label =
          abs < 45              ? "a few seconds"
          : abs < 90            ? "a minute"
          : abs < 45 * 60       ? `${Math.round(abs / 60)} minutes`
          : abs < 90 * 60       ? "an hour"
          : abs < 22 * 3600     ? `${Math.round(abs / 3600)} hours`
          : abs < 36 * 3600     ? "a day"
          : `${Math.round(abs / 86400)} days`;
        if (withoutSuffix) return label;
        return diffSec >= 0 ? `${label} ago` : `in ${label}`;
      },
    };
  },
}));

import { formatRelativeTime } from "../src/chat/util/format-relative-time";

describe("formatRelativeTime", () => {
  test("seconds → 'a few seconds'", () => {
    expect(formatRelativeTime(NOW - 10 * 1000)).toBe("a few seconds");
  });
  test("5 minutes → '5 minutes'", () => {
    expect(formatRelativeTime(NOW - 5 * 60 * 1000)).toBe("5 minutes");
  });
  test("3 hours → '3 hours'", () => {
    expect(formatRelativeTime(NOW - 3 * 3600 * 1000)).toBe("3 hours");
  });
  test("2 days → '2 days'", () => {
    expect(formatRelativeTime(NOW - 2 * 86400 * 1000)).toBe("2 days");
  });
  test("future ts (clock skew) → still suffix-less label", () => {
    expect(formatRelativeTime(NOW + 10 * 1000)).toBe("a few seconds");
  });
});
