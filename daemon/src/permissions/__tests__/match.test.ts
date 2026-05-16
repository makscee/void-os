import { describe, expect, it } from "bun:test";
import { matchPath } from "../match";

describe("matchPath", () => {
  it("matches exact glob", () => {
    expect(matchPath("/v/journal/2026-05-16.md", ["/v/journal/**"])).toBe(true);
  });
  it("rejects outside scope", () => {
    expect(matchPath("/v/work/tasks/active/X.md", ["/v/journal/**"])).toBe(false);
  });
  it("matches multi-pattern OR", () => {
    expect(
      matchPath("/v/work/active/X.md", ["/v/journal/**", "/v/work/**"]),
    ).toBe(true);
  });
  it("rejects empty pattern list", () => {
    expect(matchPath("/v/journal/X.md", [])).toBe(false);
  });
  it("treats trailing-slash dir like its contents glob", () => {
    expect(matchPath("/v/journal/X.md", ["/v/journal/**"])).toBe(true);
  });
  it("requires absolute input path", () => {
    expect(() => matchPath("relative/path", ["/v/**"])).toThrow(
      /absolute/i,
    );
  });
  it("normalizes .. segments before matching", () => {
    expect(matchPath("/v/journal/../journal/X.md", ["/v/journal/**"])).toBe(
      true,
    );
  });
});
