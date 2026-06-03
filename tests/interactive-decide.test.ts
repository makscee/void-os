import { test, expect } from "bun:test";
import { decideInteractive } from "../src/interactive-decide.ts";

test("explicit interactive flag overrides heuristic (worker name forced interactive)", () => {
  expect(decideInteractive({ name: "organize", interactive: true })).toBe(true);
});
test("explicit interactive:false overrides heuristic (conversational forced print)", () => {
  expect(decideInteractive({ name: "chat", interactive: false })).toBe(false);
});
test("conversational skills default interactive (chat/onboarding/work)", () => {
  expect(decideInteractive({ name: "chat" })).toBe(true);
  expect(decideInteractive({ name: "onboarding" })).toBe(true);
  expect(decideInteractive({ name: "work" })).toBe(true);
});
test("pure-worker skills default print (organize/deep-research/ralph/idea-intake)", () => {
  expect(decideInteractive({ name: "organize" })).toBe(false);
  expect(decideInteractive({ name: "deep-research" })).toBe(false);
  expect(decideInteractive({ name: "ralph" })).toBe(false);
  expect(decideInteractive({ name: "idea-intake" })).toBe(false);
});
test("unknown skill defaults print (conservative — keep existing one-shot behavior)", () => {
  expect(decideInteractive({ name: "some-new-skill" })).toBe(false);
});
