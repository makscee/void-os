// VOS-161: tests for the agent control registry — the two-verb (pause/kill)
// + resume intervention model.
//
// Covers:
//   - register / get / deregister lifecycle
//   - pause flips state to "paused"; resume back to "running"
//   - awaitCheckpoint resolves immediately when running, parks when paused,
//     and settles on resume
//   - kill flips to "killed", fires onKill once, and wakes a parked run
//   - kill is idempotent; resume on a killed handle is a no-op

import { test, expect } from "bun:test";
import { createAgentControlRegistry } from "../control.ts";

test("register / get / deregister lifecycle", () => {
  const reg = createAgentControlRegistry();
  expect(reg.get("a1")).toBeNull();
  expect(reg.stateOf("a1")).toBeNull();

  const h = reg.register("a1", () => {});
  expect(reg.get("a1")).toBe(h);
  expect(reg.stateOf("a1")).toBe("running");

  reg.deregister("a1");
  expect(reg.get("a1")).toBeNull();
  expect(reg.stateOf("a1")).toBeNull();
});

test("pause then resume round-trips the state", () => {
  const reg = createAgentControlRegistry();
  const h = reg.register("a1", () => {});

  h.requestPause();
  expect(h.state()).toBe("paused");
  expect(reg.stateOf("a1")).toBe("paused");

  h.requestResume();
  expect(h.state()).toBe("running");
});

test("awaitCheckpoint resolves immediately when running", async () => {
  const reg = createAgentControlRegistry();
  const h = reg.register("a1", () => {});
  // No await-park: should resolve on the microtask queue without resume.
  await h.awaitCheckpoint();
  expect(h.state()).toBe("running");
});

test("awaitCheckpoint parks while paused and settles on resume", async () => {
  const reg = createAgentControlRegistry();
  const h = reg.register("a1", () => {});
  h.requestPause();

  let resolved = false;
  const parked = h.awaitCheckpoint().then(() => {
    resolved = true;
  });

  // Give the microtask queue a beat — the checkpoint must NOT have resolved.
  await new Promise((r) => setTimeout(r, 10));
  expect(resolved).toBe(false);

  h.requestResume();
  await parked;
  expect(resolved).toBe(true);
});

test("kill flips to killed, fires onKill once, and wakes a parked run", async () => {
  const reg = createAgentControlRegistry();
  let killCalls = 0;
  const h = reg.register("a1", () => {
    killCalls += 1;
  });

  h.requestPause();
  let resolved = false;
  const parked = h.awaitCheckpoint().then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(resolved).toBe(false);

  // Kill while parked: the parked checkpoint must wake so the run loop can
  // proceed to abort instead of hanging forever.
  h.requestKill();
  await parked;
  expect(resolved).toBe(true);
  expect(h.state()).toBe("killed");
  expect(killCalls).toBe(1);

  // Idempotent: a second kill does not re-fire onKill.
  h.requestKill();
  expect(killCalls).toBe(1);
});

test("resume is a no-op on a killed handle", () => {
  const reg = createAgentControlRegistry();
  const h = reg.register("a1", () => {});
  h.requestKill();
  h.requestResume();
  expect(h.state()).toBe("killed");
});

test("pause is a no-op once killed", () => {
  const reg = createAgentControlRegistry();
  const h = reg.register("a1", () => {});
  h.requestKill();
  h.requestPause();
  expect(h.state()).toBe("killed");
});
