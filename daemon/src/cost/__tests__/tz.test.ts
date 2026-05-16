import { describe, expect, test } from "bun:test";
import { dayRangeMs } from "../tz";

describe("dayRangeMs", () => {
  test("UTC — epoch start renders to [0, 86400000)", () => {
    expect(dayRangeMs(0, "UTC")).toEqual({ startMs: 0, endMs: 86_400_000 });
  });

  test("Europe/Moscow (UTC+3, no DST) — midnight local = -3h from UTC midnight", () => {
    // 2026-05-16 03:00 UTC = 06:00 Moscow. dayRangeMs should anchor to
    // 2026-05-16 00:00 Moscow = 2026-05-15 21:00 UTC.
    const now = Date.UTC(2026, 4, 16, 3, 0, 0);   // May = month index 4
    const range = dayRangeMs(now, "Europe/Moscow");
    expect(range.startMs).toBe(Date.UTC(2026, 4, 15, 21, 0, 0));
    expect(range.endMs).toBe(Date.UTC(2026, 4, 16, 21, 0, 0));
    expect(range.endMs - range.startMs).toBe(86_400_000);   // no DST in Moscow
  });

  test("DST forward — America/New_York spring 2026 (Mar 8) = 23h day", () => {
    // 2026-03-08 12:00 local NY = 16:00 UTC (EST → EDT at 02:00 local).
    const now = Date.UTC(2026, 2, 8, 16, 0, 0);
    const range = dayRangeMs(now, "America/New_York");
    expect(range.endMs - range.startMs).toBe(23 * 3_600_000);
  });

  test("DST backward — America/New_York fall 2026 (Nov 1) = 25h day", () => {
    const now = Date.UTC(2026, 10, 1, 16, 0, 0);
    const range = dayRangeMs(now, "America/New_York");
    expect(range.endMs - range.startMs).toBe(25 * 3_600_000);
  });

  test("Fall-back ambiguous midnight — picks earlier UTC", () => {
    // On a fall-back day, local 00:00 maps to one UTC instant; but the
    // helper must converge to the earlier candidate per the spec rule.
    // Use a TZ whose fall-back HAS a midnight transition is rare; instead
    // assert against the 25h-day rule indirectly: startMs must equal
    // (UTC midnight) - (pre-DST offset), not - (post-DST offset).
    const now = Date.UTC(2026, 10, 1, 16, 0, 0);
    const range = dayRangeMs(now, "America/New_York");
    // Pre-DST offset on Nov 1 morning is -4h (EDT). Local midnight = 04:00 UTC.
    expect(range.startMs).toBe(Date.UTC(2026, 10, 1, 4, 0, 0));
  });

  test("Locale safety — parts.hour never === '24'", async () => {
    // Indirect test: any TZ at midnight roundtrips to startMs without
    // shifting by 24h. en-US would emit '24' on some ICUs; en-GB always '00'.
    const now = Date.UTC(2026, 4, 16, 0, 0, 0);
    const range = dayRangeMs(now, "UTC");
    expect(range.startMs).toBe(Date.UTC(2026, 4, 16, 0, 0, 0));
    expect(range.endMs).toBe(Date.UTC(2026, 4, 17, 0, 0, 0));
  });
});
