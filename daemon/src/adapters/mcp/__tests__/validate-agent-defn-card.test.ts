import { describe, expect, test } from "bun:test";
import { validateAgentDefnCard } from "../index";

describe("validateAgentDefnCard — network/posture validation", () => {
  test("network: 'bogus' throws clear error", () => {
    expect(() => validateAgentDefnCard({ name: "x", network: "bogus" }, "x"))
      .toThrow(/network.*must be.*none.*allow/i);
  });

  test("posture: 'sideways' throws clear error", () => {
    expect(() => validateAgentDefnCard({ name: "x", posture: "sideways" }, "x"))
      .toThrow(/posture.*must be.*read-only.*workspace-write.*open/i);
  });

  test("network: 'none' parses fine", () => {
    const defn = validateAgentDefnCard({ name: "x", network: "none" }, "x");
    expect(defn.network).toBe("none");
  });

  test("posture: 'open' parses fine", () => {
    const defn = validateAgentDefnCard({ name: "x", posture: "open" }, "x");
    expect(defn.posture).toBe("open");
  });

  test("undefined network/posture stays undefined", () => {
    const defn = validateAgentDefnCard({ name: "x" }, "x");
    expect(defn.network).toBeUndefined();
    expect(defn.posture).toBeUndefined();
  });

  test("fallbackName applied when card.name missing", () => {
    expect(validateAgentDefnCard({}, "fallback").name).toBe("fallback");
  });
});
