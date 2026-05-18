// VOS-147: registry that aligns CC's tool_use_id with the bridge slot id so
// /answer matches on first try. Tests pin the race-prone behavior the
// orchestrator and the MCP handler rely on.

import { describe, expect, it, beforeEach } from "bun:test";
import {
  setPendingAskUserToolUseId,
  takePendingAskUserToolUseId,
  _resetForTests,
} from "../ask-user-pending-registry";

describe("ask-user-pending-registry", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("set-before-take returns the stored id and clears the entry", async () => {
    setPendingAskUserToolUseId("t1", "r1", "toolu_AAA");
    const a = await takePendingAskUserToolUseId("t1", "r1", 100);
    expect(a).toBe("toolu_AAA");
    // Second take with no second set: must time out (entry cleared).
    const b = await takePendingAskUserToolUseId("t1", "r1", 50);
    expect(b).toBe(null);
  });

  it("take-before-set resolves once set arrives", async () => {
    const p = takePendingAskUserToolUseId("t2", "r2", 500);
    setTimeout(() => setPendingAskUserToolUseId("t2", "r2", "toolu_BBB"), 20);
    const v = await p;
    expect(v).toBe("toolu_BBB");
  });

  it("timeout returns null and does not leak the entry", async () => {
    const v = await takePendingAskUserToolUseId("t3", "r3", 30);
    expect(v).toBe(null);
    // A subsequent set+take cycle should still work for the same key.
    setPendingAskUserToolUseId("t3", "r3", "toolu_CCC");
    const v2 = await takePendingAskUserToolUseId("t3", "r3", 30);
    expect(v2).toBe("toolu_CCC");
  });

  it("second set replaces prior id and resolves any pending awaiter", async () => {
    setPendingAskUserToolUseId("t4", "r4", "toolu_OLD");
    setPendingAskUserToolUseId("t4", "r4", "toolu_NEW");
    const v = await takePendingAskUserToolUseId("t4", "r4", 30);
    expect(v).toBe("toolu_NEW");
  });

  it("ignores runId in the key (keys by taskId only)", async () => {
    // The orchestrator's per-turn runId is not the same as ask-user.ts's
    // spawn-time VOS_RUN_ID after the first turn. The registry must NOT
    // require runId match.
    setPendingAskUserToolUseId("t5", "orchestrator-run", "toolu_DDD");
    const v = await takePendingAskUserToolUseId("t5", "spawn-run", 30);
    expect(v).toBe("toolu_DDD");
  });

  it("isolated per taskId", async () => {
    setPendingAskUserToolUseId("tA", null, "toolu_A");
    setPendingAskUserToolUseId("tB", null, "toolu_B");
    expect(await takePendingAskUserToolUseId("tA", null, 30)).toBe("toolu_A");
    expect(await takePendingAskUserToolUseId("tB", null, 30)).toBe("toolu_B");
  });
});
