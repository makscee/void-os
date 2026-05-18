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

describe("toIntent — tools tri-state + deny constants", () => {
  test("tools undefined → intent.tools undefined (legacy maximal sentinel)", () => {
    const defn: AgentDefn = { name: "legacy" };
    expect(toIntent(defn, SCOPES_RW, SYS_DENY).tools).toBeUndefined();
  });

  test("tools=[] → intent.tools=[] (explicit empty)", () => {
    const defn: AgentDefn = { name: "no-mcp", tools: [] };
    expect(toIntent(defn, SCOPES_RW, SYS_DENY).tools).toEqual([]);
  });

  test("tools=['ask_user'] → intent.tools=['ask_user']", () => {
    const defn: AgentDefn = { name: "asker", tools: ["ask_user"] };
    expect(toIntent(defn, SCOPES_RW, SYS_DENY).tools).toEqual(["ask_user"]);
  });

  test("denyTools always equals ['AskUserQuestion']", () => {
    expect(toIntent({ name: "x" }, SCOPES_RW, SYS_DENY).denyTools).toEqual(["AskUserQuestion"]);
  });

  test("systemDenyPaths passes through verbatim", () => {
    expect(toIntent({ name: "x" }, SCOPES_RW, SYS_DENY).systemDenyPaths).toEqual(SYS_DENY);
  });

  test("systemDenyPaths empty array passes through", () => {
    expect(toIntent({ name: "x" }, SCOPES_RW, []).systemDenyPaths).toEqual([]);
  });
});

describe("toIntent — scopes pass through verbatim", () => {
  test("readPaths from scopes argument", () => {
    const scopes = { readPaths: ["/vault", "/tmp/x"], writePaths: ["/vault"] };
    const intent = toIntent({ name: "x" }, scopes, SYS_DENY);
    expect(intent.readPaths).toEqual(["/vault", "/tmp/x"]);
  });

  test("writePaths from scopes argument", () => {
    const scopes = { readPaths: ["/vault"], writePaths: ["/vault/journal"] };
    const intent = toIntent({ name: "x" }, scopes, SYS_DENY);
    expect(intent.writePaths).toEqual(["/vault/journal"]);
  });

  test("read-only scopes (writePaths=[]) pass through", () => {
    const scopes = { readPaths: ["/vault"], writePaths: [] };
    const intent = toIntent({ name: "x" }, scopes, SYS_DENY);
    expect(intent.writePaths).toEqual([]);
  });
});

describe("toIntent — explicit network/posture", () => {
  test("explicit network='none' wins", () => {
    const defn: AgentDefn = { name: "x", network: "none" };
    expect(toIntent(defn, SCOPES_RW, SYS_DENY).network).toBe("none");
  });

  test("explicit network='allow' wins (overrides default)", () => {
    const defn: AgentDefn = { name: "x", network: "allow" };
    expect(toIntent(defn, SCOPES_RW, SYS_DENY).network).toBe("allow");
  });

  test("explicit posture='open' wins (overrides write-derived default)", () => {
    const defn: AgentDefn = { name: "x", posture: "open" };
    expect(toIntent(defn, SCOPES_RW, SYS_DENY).posture).toBe("open");
  });

  test("explicit posture='read-only' wins even with non-empty writePaths", () => {
    const defn: AgentDefn = { name: "x", posture: "read-only" };
    expect(toIntent(defn, SCOPES_RW, SYS_DENY).posture).toBe("read-only");
  });
});
