import { test, expect } from "bun:test";
import { createEventBus } from "../src/events/index.ts";

test("listenerCount returns 0 on empty bus", () => {
  const bus = createEventBus();
  expect(bus.listenerCount()).toBe(0);
});

test("listenerCount sums across types", () => {
  const bus = createEventBus();
  const u1 = bus.subscribe("text", () => {});
  const u2 = bus.subscribe("text", () => {});
  const u3 = bus.subscribe("run.end", () => {});
  expect(bus.listenerCount()).toBe(3);
  u2();
  expect(bus.listenerCount()).toBe(2);
  u1();
  u3();
  expect(bus.listenerCount()).toBe(0);
});
