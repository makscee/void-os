// tests/issue.test.ts
import { test, expect } from "bun:test";
import { parseBoxes, allChecked, checkBox, nextOpenBox, drainProgress } from "../src/issue.ts";

const BODY = `Some preamble.

- [ ] Add /healthz route {auto: bun run verify} {p1}
      Route GET /healthz returns 200.
- [x] Scaffold module {auto: bun test} {p2}
- [ ] Polish empty-state copy {human} {p3}
      Needs a human eye on tone.
`;

test("parseBoxes extracts gate, priority, checked", () => {
  const boxes = parseBoxes(BODY);
  expect(boxes.length).toBe(3);
  expect(boxes[0]).toMatchObject({ checked: false, gate: { kind: "auto", check: "bun run verify" }, prio: 1, title: "Add /healthz route" });
  expect(boxes[1]).toMatchObject({ checked: true, prio: 2 });
  expect(boxes[2]).toMatchObject({ gate: { kind: "human" }, prio: 3 });
});

test("nextOpenBox returns the highest-priority OPEN box (lowest prio number)", () => {
  expect(nextOpenBox(parseBoxes(BODY))?.title).toBe("Add /healthz route");
  const allDone = BODY.replace(/- \[ \]/g, "- [x]");
  expect(nextOpenBox(parseBoxes(allDone))).toBeUndefined();
});

test("allChecked false when an open box remains, true when all checked", () => {
  expect(allChecked(parseBoxes(BODY))).toBe(false);
  expect(allChecked(parseBoxes(BODY.replace(/- \[ \]/g, "- [x]")))).toBe(true);
});

// checkBox flips ONLY the target box's line — preserves everything else, so a
// concurrent operator reshape (human-box edit) is not clobbered. Runner-owned.
test("checkBox flips only the target box line, preserves everything else", () => {
  const out = checkBox(BODY, parseBoxes(BODY)[0]);
  expect(out).toContain("- [x] Add /healthz route {auto: bun run verify} {p1}");
  expect(out).toContain("Some preamble.");
  expect(out).toContain("- [x] Scaffold module {auto: bun test} {p2}");
  expect(out).toContain("- [ ] Polish empty-state copy {human} {p3}");
  expect(out.split("\n").filter((l, i) => l !== BODY.split("\n")[i]).length).toBe(1);
});

test("checkBox is idempotent on an already-checked box", () => {
  expect(checkBox(BODY, parseBoxes(BODY)[1])).toBe(BODY);
});

test("drainProgress returns {checked,total}", () => {
  expect(drainProgress(BODY)).toEqual({ checked: 1, total: 3 });
});
