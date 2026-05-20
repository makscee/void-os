// VOS-164: unit tests for the live-agent registry — the correlation source
// the hook-event ingest route gates on.

import { describe, expect, test } from "bun:test";
import { createLiveAgentRegistry } from "../live-agents.ts";

describe("VOS-164: LiveAgentRegistry", () => {
  test("an unregistered agent_id is not live", () => {
    const reg = createLiveAgentRegistry();
    expect(reg.has("task-1")).toBe(false);
    expect(reg.size()).toBe(0);
  });

  test("register makes an agent_id live; unregister drops it", () => {
    const reg = createLiveAgentRegistry();
    reg.register("task-1");
    expect(reg.has("task-1")).toBe(true);
    expect(reg.size()).toBe(1);
    reg.unregister("task-1");
    expect(reg.has("task-1")).toBe(false);
    expect(reg.size()).toBe(0);
  });

  test("ref-counted: a second register keeps the id live until both unregister", () => {
    // A chat agent can host successive runs under the same task id. One
    // run's finalize must not unregister an id another run still holds.
    const reg = createLiveAgentRegistry();
    reg.register("task-1");
    reg.register("task-1");
    expect(reg.size()).toBe(1); // distinct ids, not registrations
    reg.unregister("task-1");
    expect(reg.has("task-1")).toBe(true); // still held by the second run
    reg.unregister("task-1");
    expect(reg.has("task-1")).toBe(false);
  });

  test("unregister on an unknown id is a no-op", () => {
    const reg = createLiveAgentRegistry();
    expect(() => reg.unregister("ghost")).not.toThrow();
    expect(reg.size()).toBe(0);
  });

  test("unregister never drives the ref-count negative", () => {
    const reg = createLiveAgentRegistry();
    reg.register("task-1");
    reg.unregister("task-1");
    reg.unregister("task-1"); // extra unregister
    expect(reg.has("task-1")).toBe(false);
    reg.register("task-1"); // a fresh run still works
    expect(reg.has("task-1")).toBe(true);
  });

  test("empty / non-string agent_id is ignored on register", () => {
    const reg = createLiveAgentRegistry();
    reg.register("");
    expect(reg.size()).toBe(0);
    // @ts-expect-error — defensive: guard against a malformed caller.
    reg.register(undefined);
    expect(reg.size()).toBe(0);
  });

  test("_reset clears everything", () => {
    const reg = createLiveAgentRegistry();
    reg.register("a");
    reg.register("b");
    reg._reset();
    expect(reg.size()).toBe(0);
    expect(reg.has("a")).toBe(false);
  });
});
