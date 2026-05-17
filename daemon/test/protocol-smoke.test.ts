import { test, expect } from "bun:test";
import { HealthResp } from "@voidos/protocol";

test("daemon can import HealthResp from @voidos/protocol", () => {
  const sample = HealthResp.parse({
    ok: true,
    version: "0.0.1",
    vault_root: "/tmp",
    uptime_s: 1,
    sessions: 0,
  });
  expect(sample.ok).toBe(true);
});
