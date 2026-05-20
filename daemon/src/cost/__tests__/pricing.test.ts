import { describe, expect, test, mock } from "bun:test";
import { PRICING, priceFor } from "../pricing";

describe("priceFor", () => {
  test("opus 4.7 — exact math across 4 buckets", () => {
    const usd = priceFor("claude-opus-4-7", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreateTokens: 10_000,
      cacheReadTokens: 50_000,
    });
    // 1e6 * 15e-6 + 1e5 * 75e-6 + 1e4 * 18.75e-6 + 5e4 * 1.5e-6
    // = 15 + 7.5 + 0.1875 + 0.075 = 22.7625
    expect(usd).toBeCloseTo(22.7625, 8);
  });

  test("sonnet 4.6 — exact math", () => {
    const usd = priceFor("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    });
    expect(usd).toBeCloseTo(3.0, 8);
  });

  test("haiku 4.5 — exact math", () => {
    const usd = priceFor("claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    });
    expect(usd).toBeCloseTo(4.0, 8);
  });

  test("unknown model — returns 0, logs cost.unknown_model", () => {
    const warn = mock(() => {});
    const usd = priceFor("claude-future-99", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    }, { warn });
    expect(usd).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const firstCall = warn.mock.calls[0] as unknown as unknown[];
    expect(firstCall[0]).toBe("cost.unknown_model");
    expect(firstCall[1]).toEqual({ model: "claude-future-99" });
  });

  test("cache weighting distinct from input rate", () => {
    // Guard against accidental fold: cache_read should be cheaper than input.
    const opus = PRICING["claude-opus-4-7"]!;
    expect(opus.cacheRead).toBeLessThan(opus.input);
    expect(opus.cacheCreate).toBeGreaterThan(opus.input);
  });
});
