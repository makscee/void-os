import { describe, test, expect } from "bun:test";
import { formatTokens } from "./format-tokens";

describe("formatTokens", () => {
  const cases: Array<[number | null, string]> = [
    [null, "—"],
    [0, "0"],
    [42, "42"],
    [999, "999"],
    [1000, "1k"],
    [1234, "1.2k"],
    [12_345, "12.3k"],
    [120_000, "120k"],
    [998_000, "998k"],
    [999_499, "999.5k"],
    [999_500, "1.0M"],
    [999_999, "1.0M"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
    [12_345_678, "12.3M"],
  ];
  for (const [input, expected] of cases) {
    test(`${input} → ${expected}`, () => {
      expect(formatTokens(input)).toBe(expected);
    });
  }
});
