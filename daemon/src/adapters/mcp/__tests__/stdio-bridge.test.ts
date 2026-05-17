import { describe, test, expect } from "bun:test";
import { validateBridgeEnv, stampMeta } from "../stdio-bridge.ts";

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

describe("stampMeta", () => {
  const cfg = {
    daemonBase: "http://127.0.0.1:8729",
    agent: "maya",
    taskId: "T-1",
    contextId: "C-1",
    runId: "R-1",
  } as const;

  test("stamps task_id / context_id / run_id on tools/call", () => {
    const out = stampMeta(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: {} } },
      cfg,
    );
    expect(out.params._meta).toEqual({
      task_id: "T-1",
      context_id: "C-1",
      run_id: "R-1",
    });
  });

  test("omits run_id when null", () => {
    const out = stampMeta(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } },
      { ...cfg, runId: null },
    );
    expect("run_id" in (out.params._meta as object)).toBe(false);
  });

  test("preserves model-supplied _meta fields the daemon does not stamp", () => {
    const out = stampMeta(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "ask_user", arguments: {}, _meta: { _vos_tool_use_id: "tu-123" } },
      },
      cfg,
    );
    expect((out.params._meta as Record<string, unknown>)._vos_tool_use_id).toBe("tu-123");
    expect((out.params._meta as Record<string, unknown>).task_id).toBe("T-1");
  });

  test("daemon-stamped fields override model-supplied task_id", () => {
    const out = stampMeta(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "ask_user", arguments: {}, _meta: { task_id: "SPOOF" } },
      },
      cfg,
    );
    expect((out.params._meta as Record<string, unknown>).task_id).toBe("T-1");
  });

  test("passthrough on initialize / tools/list / notifications", () => {
    const inputs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
    for (const m of inputs) {
      expect(stampMeta(m, cfg)).toEqual(m);
    }
  });
});
