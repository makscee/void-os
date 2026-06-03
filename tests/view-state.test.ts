import { test, expect } from "bun:test";
import { bodyHasRealContent, isResumable } from "../src/view-state.ts";
import { placeholderBody } from "../src/render.ts";

test("placeholder body is NOT real content", () => {
  expect(bodyHasRealContent(placeholderBody("skill-author"))).toBe(false);
});
test("a real HTML doc IS real content", () => {
  expect(bodyHasRealContent("<!doctype html><title>Results</title><body><h1>hi</h1>")).toBe(true);
});
test("empty / missing body is NOT real content", () => {
  expect(bodyHasRealContent("")).toBe(false);
});
test("isResumable true when ccId present (no live tmux needed)", () => {
  expect(isResumable({ liveTmux: false, ccId: "CC-1" })).toBe(true);
});
test("isResumable true when live tmux (no ccId)", () => {
  expect(isResumable({ liveTmux: true, ccId: null })).toBe(true);
});
test("isResumable false when neither live tmux nor ccId", () => {
  expect(isResumable({ liveTmux: false, ccId: null })).toBe(false);
});
test("placeholder body with different skill name is NOT real content", () => {
  expect(bodyHasRealContent(placeholderBody("deep-research"))).toBe(false);
});
test("no-arg placeholder is NOT real content", () => {
  expect(bodyHasRealContent(placeholderBody())).toBe(false);
});

// ── VOS-210 T5: grep guard — view path never reads output_target ──────────

import { readFileSync } from "node:fs";
test("the view-state + render path never reads output_target", () => {
  for (const f of ["../src/view-state.ts", "../src/render.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    expect(src).not.toContain("outputTarget");
    expect(src).not.toContain("output_target");
  }
});
