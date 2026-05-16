import { test, expect } from "bun:test";
import { formatUsd } from "../src/chat/format-usd";

test("zero → $0.00", () => {
  expect(formatUsd(0)).toBe("$0.00");
});

test("sub-cent values round down to $0.00", () => {
  expect(formatUsd(0.004)).toBe("$0.00");
  expect(formatUsd(0.0049)).toBe("$0.00");
});

test("rounds half-up at the cent (0.005 → $0.01)", () => {
  expect(formatUsd(0.005)).toBe("$0.01");
});

test("formats two decimals", () => {
  expect(formatUsd(0.42)).toBe("$0.42");
  expect(formatUsd(1)).toBe("$1.00");
  expect(formatUsd(10)).toBe("$10.00");
  expect(formatUsd(1234.5)).toBe("$1234.50");
});

test("NaN / Infinity / negative clamp to $0.00", () => {
  expect(formatUsd(Number.NaN)).toBe("$0.00");
  expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$0.00");
  expect(formatUsd(-1)).toBe("$0.00");
});
