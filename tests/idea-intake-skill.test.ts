// tests/idea-intake-skill.test.ts — VOS-195 idea-intake static contract.
// Locks: SKILL.md frontmatter, output_target glob, trigger binding, kind=idea routing.
import { test, expect } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { wasMutatedSince } from "../src/output-target.ts";
import { parseTrigger } from "../src/trigger.ts";
import { parseBusLine } from "../src/bus-line.ts";
import { routeBusLine, type RoutableTrigger } from "../src/bus-route.ts";

const SKILL_PATH = join(import.meta.dir, "../catalog/skills/idea-intake/SKILL.md");
const SKILL = readFileSync(SKILL_PATH, "utf8");

test("idea-intake SKILL.md declares the backlog glob output target", () => {
  const meta = parseFrontmatter(SKILL);
  expect(meta.name).toBe("idea-intake");
  expect(meta.needsInput).toBe(true);
  expect(meta.outputTarget).toBe("vault/work/tasks/backlog/*.md");
});

test("a newly written backlog file satisfies the glob output target", () => {
  const dir = `/tmp/vos195-${Date.now()}`;
  mkdirSync(join(dir, "vault/work/tasks/backlog"), { recursive: true });
  const started = Date.now();
  writeFileSync(join(dir, "vault/work/tasks/backlog/VOS-999-test-task.md"), "stub content");
  expect(wasMutatedSince(dir, "vault/work/tasks/backlog/*.md", started)).toBe(true);
});

test("idea-trigger binds kind=idea to the idea-intake skill", () => {
  const trigText = [
    "---",
    "kind: event",
    "skill: idea-intake",
    "agent: default",
    "inbox: bus",
    "event_kind: idea",
    "step_ceiling: 30",
    "---",
  ].join("\n");
  const trig = parseTrigger("idea-intake", trigText);
  expect(trig.kind).toBe("event");
  expect(trig.skill).toBe("idea-intake");
  expect(trig.eventKind).toBe("idea");
  expect(trig.inbox).toBe("bus");
  expect(trig.stepCeiling).toBe(30);
});

test("a kind=idea bus line routes to the idea-intake trigger", () => {
  // RoutableTrigger.kind is the event-kind filter (matches bus line's kind field)
  const triggers: RoutableTrigger[] = [{
    name: "idea-intake",
    inbox: "bus",
    kind: "idea",        // event-kind filter
    skill: "idea-intake",
    agent: "default",
    enabled: 1,
  }];
  const line = parseBusLine(JSON.stringify({
    id: "bl-test-abc",
    kind: "idea",
    channel: "file",
    payload: "build a /reports page that lists generated HTML reports",
  }));
  const route = routeBusLine(line, "bus", triggers);
  expect(route?.triggerName).toBe("idea-intake");
  expect(route?.skill).toBe("idea-intake");
});

test("a kind=chat bus line does NOT route to the idea-intake trigger", () => {
  const triggers: RoutableTrigger[] = [{
    name: "idea-intake",
    inbox: "bus",
    kind: "idea",
    skill: "idea-intake",
    agent: "default",
    enabled: 1,
  }];
  const line = parseBusLine(JSON.stringify({
    id: "bl-test-chat",
    kind: "chat",
    channel: "file",
    payload: "hello",
  }));
  const route = routeBusLine(line, "bus", triggers);
  expect(route).toBeNull();
});
