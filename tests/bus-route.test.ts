// tests/bus-route.test.ts
import { expect, test } from "bun:test";
import { routeBusLine, type RoutableTrigger } from "../src/bus-route.ts";
import { parseBusLine } from "../src/bus-line.ts";

const trig = (o: Partial<RoutableTrigger>): RoutableTrigger =>
  ({ name: "t", inbox: "bus", kind: null, skill: "s", agent: "a", enabled: 1, ...o });

const line = (kind: string, routing: object = {}) =>
  parseBusLine(JSON.stringify({ channel: "file", kind, payload: "p", routing }));

test("routes by matching kind", () => {
  const triggers = [trig({ name: "idea-t", kind: "idea", skill: "intake" }), trig({ name: "chat-t", kind: "chat", skill: "chat" })];
  const r = routeBusLine(line("idea"), "bus", triggers);
  expect(r?.triggerName).toBe("idea-t");
  expect(r?.skill).toBe("intake");
});

test("kindless trigger matches any kind (189 back-compat)", () => {
  const r = routeBusLine(line("chat"), "bus", [trig({ name: "any-t", kind: null })]);
  expect(r?.triggerName).toBe("any-t");
});

test("line routing.skill overrides matched trigger skill", () => {
  const r = routeBusLine(line("idea", { skill: "override" }), "bus", [trig({ name: "idea-t", kind: "idea", skill: "intake" })]);
  expect(r?.skill).toBe("override");
});

test("no match → null", () => {
  expect(routeBusLine(line("decision-reply"), "bus", [trig({ kind: "idea" })])).toBeNull();
});

test("disabled trigger does not match", () => {
  expect(routeBusLine(line("idea"), "bus", [trig({ kind: "idea", enabled: 0 })])).toBeNull();
});

test("wrong inbox does not match", () => {
  expect(routeBusLine(line("idea"), "other", [trig({ inbox: "bus", kind: "idea" })])).toBeNull();
});
