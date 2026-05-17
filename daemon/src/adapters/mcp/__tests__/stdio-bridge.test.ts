import { describe, test, expect } from "bun:test";
import { validateBridgeEnv } from "../stdio-bridge.ts";

describe("validateBridgeEnv", () => {
  test("returns config when all required vars present", () => {
    const cfg = validateBridgeEnv({
      VOS_DAEMON_BASE: "http://127.0.0.1:8729",
      VOS_AGENT: "maya",
      VOS_TASK_ID: "T-1",
      VOS_CONTEXT_ID: "C-1",
      VOS_RUN_ID: "R-1",
    });
    expect(cfg).toEqual({
      daemonBase: "http://127.0.0.1:8729",
      agent: "maya",
      taskId: "T-1",
      contextId: "C-1",
      runId: "R-1",
    });
  });

  test("defaults VOS_CONTEXT_ID to VOS_TASK_ID when absent", () => {
    const cfg = validateBridgeEnv({
      VOS_DAEMON_BASE: "http://127.0.0.1:8729",
      VOS_AGENT: "maya",
      VOS_TASK_ID: "T-1",
    });
    expect(cfg.contextId).toBe("T-1");
    expect(cfg.runId).toBeNull();
  });

  test("throws on missing required var", () => {
    expect(() =>
      validateBridgeEnv({ VOS_AGENT: "maya", VOS_TASK_ID: "T-1" }),
    ).toThrow(/VOS_DAEMON_BASE/);
  });
});
