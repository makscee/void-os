import { test, expect } from "bun:test";
import { HealthResp, StreamFrame } from "../src/index.ts";

test("HealthResp parses a complete fixture", () => {
  const fixture = {
    ok: true,
    version: "0.0.1",
    vault_root: "/tmp/vault",
    uptime_s: 42,
    sessions: 0,
  };
  expect(() => HealthResp.parse(fixture)).not.toThrow();
});

test("HealthResp rejects negative uptime", () => {
  expect(() => HealthResp.parse({ ok: true, version: "x", vault_root: "/", uptime_s: -1, sessions: 0 })).toThrow();
});

test("HealthResp infers correct type", () => {
  // Compile-time: this is a type test. If HealthResp type drifts, tsc fails.
  const x: HealthResp = { ok: true, version: "v", vault_root: "/v", uptime_s: 0, sessions: 0 };
  expect(x.ok).toBe(true);
});

test("StreamFrame accepts hello", () => {
  expect(() => StreamFrame.parse({ event: "hello", data: { chat_id: "c1", version: "0.0.1" } })).not.toThrow();
});

test("StreamFrame rejects unknown event", () => {
  expect(() => StreamFrame.parse({ event: "weird", data: {} })).toThrow();
});
