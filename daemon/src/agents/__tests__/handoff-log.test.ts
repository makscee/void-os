// VOS-154: handoff-log adapter — exercises the real hl CLI against a temp
// HUB_ROOT, no mocking. Confirms (1) NULL adapter no-ops cleanly,
// (2) dispatch returns an id + writes JSONL + stores bundle,
// (3) return matches via --parent.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeHandoffLog,
  makeHandoffLogFromEnv,
  NULL_HANDOFF_LOG,
} from "../handoff-log.ts";

// Path to the hub-side hl binary. Tests fail loudly if absent — the daemon's
// integration with handoff-log is the contract here, and a missing binary
// means the operator's hub layout drifted.
const HL_BIN = "/Users/admin/hub/tools/handoff-log/hl";

describe("handoff-log adapter", () => {
  test("NULL_HANDOFF_LOG is a safe no-op", async () => {
    const id1 = await NULL_HANDOFF_LOG.dispatch({
      fromAgentId: "a",
      toAgentId: "b",
      bundleText: "hi",
    });
    expect(id1).toBeNull();
    const id2 = await NULL_HANDOFF_LOG.return({
      fromAgentId: "b",
      toAgentId: "a",
      status: "DONE",
    });
    expect(id2).toBeNull();
  });

  test("makeHandoffLog with no path -> NULL adapter", async () => {
    const log = makeHandoffLog({});
    expect(log).toBe(NULL_HANDOFF_LOG);
  });

  test("makeHandoffLogFromEnv with no VOID_OS_HL_PATH -> NULL adapter", () => {
    const log = makeHandoffLogFromEnv({});
    expect(log).toBe(NULL_HANDOFF_LOG);
  });

  test("dispatch writes JSONL + bundle, return links via --parent", async () => {
    const hubRoot = mkdtempSync(join(tmpdir(), "vos-hl-test-"));
    const log = makeHandoffLog({ hlPath: HL_BIN, hubRoot });

    const dispatchId = await log.dispatch({
      fromAgentId: "orchestrator:wm-test/1",
      toAgentId: "impl:VOS-154/1",
      taskId: "VOS-154",
      milestone: "dogfood-void-os-workflow",
      session: "test-session",
      bundleText: "Hello, child agent. Please discover X.",
      expectedContract: "subagent-contract.md 8-status",
      notes: "unit test",
    });
    expect(dispatchId).toBeTruthy();
    expect(dispatchId).toMatch(/^\d{13,}-[a-f0-9]{6}$/);

    const logPath = join(hubRoot, "vault/work/handoffs/log.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((s) => s.length > 0);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.kind).toBe("dispatch");
    expect(entry.from_agent_id).toBe("orchestrator:wm-test/1");
    expect(entry.to_agent_id).toBe("impl:VOS-154/1");
    expect(entry.task_id).toBe("VOS-154");
    expect(entry.milestone).toBe("dogfood-void-os-workflow");
    expect(entry.expected_contract).toBe("subagent-contract.md 8-status");
    expect(entry.bundle_sha256).toMatch(/^[a-f0-9]{64}$/);

    // Bundle stored content-addressed.
    const bundleDir = join(hubRoot, "vault/work/handoffs/bundles");
    const bundleFiles = readdirSync(bundleDir);
    expect(bundleFiles.length).toBe(1);
    expect(bundleFiles[0]).toBe(`${entry.bundle_sha256}.md`);

    // Now write a return linked to the dispatch.
    const returnId = await log.return({
      fromAgentId: "impl:VOS-154/1",
      toAgentId: "orchestrator:wm-test/1",
      taskId: "VOS-154",
      milestone: "dogfood-void-os-workflow",
      session: "test-session",
      status: "DONE",
      summary: "wired hl into ask_agent",
      durationMs: 12345,
      parentHandoffId: dispatchId!,
    });
    expect(returnId).toBeTruthy();
    expect(returnId).not.toBe(dispatchId);

    const lines2 = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((s) => s.length > 0);
    expect(lines2.length).toBe(2);
    const ret = JSON.parse(lines2[1]!) as Record<string, unknown>;
    expect(ret.kind).toBe("return");
    expect(ret.return_status).toBe("DONE");
    expect(ret.return_summary).toBe("wired hl into ask_agent");
    expect(ret.duration_ms).toBe(12345);
    expect(ret.parent_handoff_id).toBe(dispatchId);
  });

  test("dispatch with missing binary -> null + no throw", async () => {
    const log = makeHandoffLog({ hlPath: "/nonexistent/hl" });
    let warned = "";
    const log2 = makeHandoffLog({
      hlPath: "/nonexistent/hl",
      warn: (m) => {
        warned = m;
      },
    });
    const id = await log2.dispatch({
      fromAgentId: "a",
      toAgentId: "b",
      bundleText: "x",
    });
    expect(id).toBeNull();
    expect(warned).toContain("spawn");
    // First log instance also works
    expect(log).toBeDefined();
  });
});
