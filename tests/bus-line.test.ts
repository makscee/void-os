// tests/bus-line.test.ts
import { expect, test } from "bun:test";
import { parseBusLine, type BusLine } from "../src/bus-line.ts";

test("parses a full file-channel idea line", () => {
  const line = JSON.stringify({
    channel: "file", kind: "idea", payload: "build a thing",
    routing: { skill: "intake", agent: "default" }, id: "bl-1", ts: 1700000000000,
  });
  const bl = parseBusLine(line);
  expect(bl.channel).toBe("file");
  expect(bl.kind).toBe("idea");
  expect(bl.payload).toBe("build a thing");
  expect(bl.routing.skill).toBe("intake");
  expect(bl.id).toBe("bl-1");
  expect(bl.ts).toBe(1700000000000);
});

test("defaults id and ts when absent", () => {
  const bl = parseBusLine(JSON.stringify({ channel: "file", kind: "chat", payload: "hi" }), 1700000000001);
  expect(bl.id).toMatch(/^bl-/);
  expect(bl.ts).toBe(1700000000001);
  expect(bl.routing).toEqual({});
});

test("rejects unknown channel", () => {
  expect(() => parseBusLine(JSON.stringify({ channel: "carrier-pigeon", kind: "idea", payload: "x" }))).toThrow(/channel/);
});

test("accepts custom (non-built-in) kind for extensible routing", () => {
  // parseBusLine accepts any non-empty kind; routeBusLine is the sole gate for routability.
  const bl = parseBusLine(JSON.stringify({ channel: "file", kind: "stdio-proof", payload: "fire" }));
  expect(bl.kind).toBe("stdio-proof");
});

test("rejects missing kind (empty string)", () => {
  expect(() => parseBusLine(JSON.stringify({ channel: "file", kind: "", payload: "x" }))).toThrow(/kind/);
});

test("rejects missing payload", () => {
  expect(() => parseBusLine(JSON.stringify({ channel: "file", kind: "idea" }))).toThrow(/payload/);
});

test("rejects non-JSON line", () => {
  expect(() => parseBusLine("not json")).toThrow();
});

test("decision-reply carries decisionRef in routing", () => {
  const bl = parseBusLine(JSON.stringify({
    channel: "tg", kind: "decision-reply", payload: "option-a",
    routing: { decisionRef: "dec-7", execRef: "exec-9" }, id: "bl-2", ts: 5,
  }));
  expect(bl.kind).toBe("decision-reply");
  expect(bl.routing.decisionRef).toBe("dec-7");
  expect(bl.routing.execRef).toBe("exec-9");
});
