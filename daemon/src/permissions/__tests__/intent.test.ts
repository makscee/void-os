// daemon/src/permissions/__tests__/intent.test.ts
import { describe, expect, test } from "bun:test";
import { toIntent, type AgentPermissionIntent } from "../intent";
import type { AgentDefn } from "../engine";

const SCOPES_RO = { readPaths: ["/vault"], writePaths: [] };
const SCOPES_RW = { readPaths: ["/vault"], writePaths: ["/vault/journal"] };
const SYS_DENY = ["/root", "/home/user/.ssh"];

describe("toIntent — type shape", () => {
  test("returns an object with all intent fields", () => {
    const defn: AgentDefn = { name: "test-agent" };
    const intent: AgentPermissionIntent = toIntent(defn, SCOPES_RO, SYS_DENY);
    expect(intent).toHaveProperty("readPaths");
    expect(intent).toHaveProperty("writePaths");
    expect(intent).toHaveProperty("denyTools");
    expect(intent).toHaveProperty("systemDenyPaths");
    expect(intent).toHaveProperty("network");
    expect(intent).toHaveProperty("posture");
    // `tools` is tri-state — optional
    expect("tools" in intent || intent.tools === undefined).toBe(true);
  });
});
