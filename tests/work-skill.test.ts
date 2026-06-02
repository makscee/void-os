// tests/work-skill.test.ts — VOS-196 work-skill static contract.
// Locks: SKILL.md frontmatter, output_target glob, trigger binding, kind=work routing.
import { test, expect } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { wasMutatedSince } from "../src/output-target.ts";
import { parseTrigger } from "../src/trigger.ts";
import { parseBusLine } from "../src/bus-line.ts";
import { routeBusLine, type RoutableTrigger } from "../src/bus-route.ts";

const SKILL_PATH = join(import.meta.dir, "../catalog/skills/work/SKILL.md");
const SKILL = readFileSync(SKILL_PATH, "utf8");

test("work SKILL.md declares the active-tasks glob output target", () => {
  const meta = parseFrontmatter(SKILL);
  expect(meta.name).toBe("work");
  expect(meta.needsInput).toBe(true);
  expect(meta.outputTarget).toBe("vault/work/tasks/active/*.md");
});

test("a mutated active task file satisfies the glob output target", () => {
  const dir = `/tmp/vos196-${Date.now()}`;
  mkdirSync(join(dir, "vault/work/tasks/active"), { recursive: true });
  const started = Date.now();
  writeFileSync(join(dir, "vault/work/tasks/active/VOS-999-test-task.md"), "stub content\n\n## Result\n\n- completed: 2026-06-02");
  expect(wasMutatedSince(dir, "vault/work/tasks/active/*.md", started)).toBe(true);
});

test("work-trigger binds kind=work to the work skill", () => {
  const trigText = [
    "---",
    "kind: event",
    "skill: work",
    "agent: default",
    "inbox: bus",
    "event_kind: work",
    "step_ceiling: 50",
    "---",
  ].join("\n");
  const trig = parseTrigger("work", trigText);
  expect(trig.kind).toBe("event");
  expect(trig.skill).toBe("work");
  expect(trig.eventKind).toBe("work");
  expect(trig.inbox).toBe("bus");
  expect(trig.stepCeiling).toBe(50);
});

test("a kind=work bus line routes to the work trigger", () => {
  const triggers: RoutableTrigger[] = [{
    name: "work",
    inbox: "bus",
    kind: "work",
    skill: "work",
    agent: "default",
    enabled: 1,
  }];
  const line = parseBusLine(JSON.stringify({
    id: "bl-test-work-001",
    kind: "work",
    channel: "file",
    payload: "vault/work/tasks/active/VOS-999-test-task.md",
  }));
  const route = routeBusLine(line, "bus", triggers);
  expect(route?.triggerName).toBe("work");
  expect(route?.skill).toBe("work");
});

test("a kind=idea bus line does NOT route to the work trigger", () => {
  const triggers: RoutableTrigger[] = [{
    name: "work",
    inbox: "bus",
    kind: "work",
    skill: "work",
    agent: "default",
    enabled: 1,
  }];
  const line = parseBusLine(JSON.stringify({
    id: "bl-test-idea-002",
    kind: "idea",
    channel: "file",
    payload: "build something cool",
  }));
  const route = routeBusLine(line, "bus", triggers);
  expect(route).toBeNull();
});

test("a kind=chat bus line does NOT route to the work trigger", () => {
  const triggers: RoutableTrigger[] = [{
    name: "work",
    inbox: "bus",
    kind: "work",
    skill: "work",
    agent: "default",
    enabled: 1,
  }];
  const line = parseBusLine(JSON.stringify({
    id: "bl-test-chat-003",
    kind: "chat",
    channel: "file",
    payload: "hello",
  }));
  const route = routeBusLine(line, "bus", triggers);
  expect(route).toBeNull();
});
