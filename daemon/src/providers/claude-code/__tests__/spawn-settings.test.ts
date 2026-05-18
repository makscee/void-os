import { describe, expect, it, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALLOWED_BUILTIN_TOOLS,
  ALLOWED_MCP_SERVERS,
  ALLOWED_MCP_TOOLS_VOID_OS,
  ALLOWED_TOOLS,
  _resetLegacyToolsWarnedForTests,
  buildSpawnSettings,
  computeEffectiveTools,
  mcpToolNameFor,
} from "../spawn-settings";

const VAULT = "/tmp/vos-106-vault-test";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "vos-106-spawn-"));
}

describe("buildSpawnSettings", () => {
  it("writes settings.json with PreToolUse hook + additionalDirectories", () => {
    const dir = freshDir();
    const { settingsPath, mcpConfigPath, env } = buildSpawnSettings({
      agentName: "maya",
      scopes: {
        readPaths: [`${VAULT}/**`, "/Users/x/.config/something"],
        writePaths: [`${VAULT}/work/**`],
      },
      systemDeny: [`${VAULT}/agents/**`],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "run-abc",
      taskId: "T-test",
      contextId: "C-test",
      settingsDir: dir,
      hookScriptPath: "/abs/pre-tool-use.ts",
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PreToolUse[0].matcher).toBe(
      "Read|Glob|Grep|Bash|Edit|Write|MultiEdit",
    );
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(
      /bun .*\/abs\/pre-tool-use\.ts$/,
    );
    expect(settings.additionalDirectories).toEqual(["/Users/x/.config/something"]);
    // VOS-107 review followup: AskUserQuestion is denied so agents fall back to
    // the daemon's ask_user path instead of CC's built-in tool.
    expect(settings.permissions.deny).toEqual(["AskUserQuestion"]);
    expect(Array.isArray(settings.permissions.allow)).toBe(true);
  });

  test("mcp.json now uses stdio transport with env-stamped runtime ids", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vos112-"));
    const built = buildSpawnSettings({
      agentName: "maya",
      scopes: { readPaths: [], writePaths: [] },
      systemDeny: [],
      vaultRoot: "/vault",
      daemonBase: "http://127.0.0.1:8729",
      runId: "R-1",
      taskId: "T-1",
      contextId: "C-1",
      settingsDir: tmp,
      hookScriptPath: "/hook.ts",
    });
    const mcp = JSON.parse(readFileSync(built.mcpConfigPath, "utf8")) as {
      mcpServers: { "void-os": { type: string; command: string; args: string[]; env: Record<string, string> } };
    };
    const entry = mcp.mcpServers["void-os"];
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toHaveLength(1);
    expect(entry.args[0]).toMatch(/stdio-bridge\.ts$/);
    expect(entry.env.VOS_DAEMON_BASE).toBe("http://127.0.0.1:8729");
    expect(entry.env.VOS_AGENT).toBe("maya");
    expect(entry.env.VOS_TASK_ID).toBe("T-1");
    expect(entry.env.VOS_CONTEXT_ID).toBe("C-1");
    expect(entry.env.VOS_RUN_ID).toBe("R-1");
    expect((entry as Record<string, unknown>).url).toBeUndefined();
  });

  it("env exports JSON-encoded scope arrays", () => {
    const { env } = buildSpawnSettings({
      agentName: "x",
      scopes: { readPaths: ["/r"], writePaths: ["/w"] },
      systemDeny: ["/d"],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "r",
      taskId: "T-test",
      contextId: "C-test",
      settingsDir: freshDir(),
      hookScriptPath: "/h",
    });
    expect(JSON.parse(env.VOS_READ_PATHS)).toEqual(["/r"]);
    expect(JSON.parse(env.VOS_WRITE_PATHS)).toEqual(["/w"]);
    expect(JSON.parse(env.VOS_SYSTEM_DENY)).toEqual(["/d"]);
    expect(env.VOS_VAULT_ROOT).toBe(VAULT);
  });

  it("env.NO_PROXY pins loopback so claudev's HTTPS_PROXY does not capture /mcp", () => {
    // VOS-106 T10.C regression: without NO_PROXY=127.0.0.1,localhost,::1
    // claudev's exported HTTPS_PROXY routes CC's MCP HTTP transport through
    // the CONNECT-only proxy and the handshake fails with
    // `mcp_servers[void-os].status="failed"`.
    const prev = process.env.NO_PROXY;
    delete process.env.NO_PROXY;
    try {
      const { env } = buildSpawnSettings({
        agentName: "x",
        scopes: { readPaths: ["/r"], writePaths: ["/w"] },
        systemDeny: [],
        vaultRoot: VAULT,
        daemonBase: "http://127.0.0.1:17777",
        runId: "r",
        taskId: "T-test",
        contextId: "C-test",
        settingsDir: freshDir(),
        hookScriptPath: "/h",
      });
      const entries = (env.NO_PROXY ?? "").split(",");
      expect(entries).toContain("127.0.0.1");
      expect(entries).toContain("localhost");
      expect(entries).toContain("::1");
    } finally {
      if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
    }
  });

  it("env.NO_PROXY preserves operator-set NO_PROXY entries", () => {
    const prev = process.env.NO_PROXY;
    process.env.NO_PROXY = "example.internal,10.0.0.0/8";
    try {
      const { env } = buildSpawnSettings({
        agentName: "x",
        scopes: { readPaths: [], writePaths: [] },
        systemDeny: [],
        vaultRoot: VAULT,
        daemonBase: "http://127.0.0.1:17777",
        runId: "r",
        taskId: "T-test",
        contextId: "C-test",
        settingsDir: freshDir(),
        hookScriptPath: "/h",
      });
      expect(env.NO_PROXY).toContain("127.0.0.1");
      expect(env.NO_PROXY).toContain("example.internal");
      expect(env.NO_PROXY).toContain("10.0.0.0/8");
    } finally {
      if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
    }
  });

  it("additionalDirectories excludes paths under vaultRoot (cwd already covers them)", () => {
    const dir = freshDir();
    const { settingsPath } = buildSpawnSettings({
      agentName: "a",
      scopes: {
        readPaths: [`${VAULT}/journal/**`, `${VAULT}/work/**`],
        writePaths: [`${VAULT}/journal/**`],
      },
      systemDeny: [],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "r",
      taskId: "T-test",
      contextId: "C-test",
      settingsDir: dir,
      hookScriptPath: "/h",
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.additionalDirectories).toEqual([]);
  });

  test("AC-5: mcp.json command+args are byte-equal across two consecutive spawns of the same agent (only env differs)", () => {
    const tmp1 = mkdtempSync(join(tmpdir(), "vos112-cache-1-"));
    const tmp2 = mkdtempSync(join(tmpdir(), "vos112-cache-2-"));
    const baseArgs = {
      agentName: "maya",
      scopes: { readPaths: [], writePaths: [] },
      systemDeny: [],
      vaultRoot: "/vault",
      daemonBase: "http://127.0.0.1:8729",
      hookScriptPath: "/hook.ts",
    };
    const a = buildSpawnSettings({
      ...baseArgs,
      runId:     "R-1",
      taskId:    "T-1",
      contextId: "C-1",
      settingsDir: tmp1,
    });
    const b = buildSpawnSettings({
      ...baseArgs,
      runId:     "R-2",
      taskId:    "T-2",
      contextId: "C-2",
      settingsDir: tmp2,
    });
    const mcpA = JSON.parse(readFileSync(a.mcpConfigPath, "utf8")) as {
      mcpServers: { "void-os": { command: string; args: string[]; env: Record<string, string> } };
    };
    const mcpB = JSON.parse(readFileSync(b.mcpConfigPath, "utf8")) as {
      mcpServers: { "void-os": { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(mcpA.mcpServers["void-os"].command).toBe(mcpB.mcpServers["void-os"].command);
    expect(mcpA.mcpServers["void-os"].args).toEqual(mcpB.mcpServers["void-os"].args);
    expect(mcpA.mcpServers["void-os"].env.VOS_TASK_ID).not.toBe(mcpB.mcpServers["void-os"].env.VOS_TASK_ID);
  });
});

describe("VOS-111: tool allowlist + name transform", () => {
  test("ALLOWED_TOOLS contains the pinned built-ins + void-os MCP tools", () => {
    expect(ALLOWED_TOOLS).toEqual([
      "Bash",
      "Edit",
      "MultiEdit",
      "Read",
      "Write",
      "Grep",
      "Glob",
      "NotebookEdit",
      "NotebookRead",
      "TodoWrite",
      "WebFetch",
      "WebSearch",
      "mcp__void-os__vault_read",
      "mcp__void-os__vault_create",
      "mcp__void-os__vault_append",
      "mcp__void-os__vault_replace_section",
      "mcp__void-os__vault_set_property",
      "mcp__void-os__vault_patch",
      "mcp__void-os__vault_delete",
      "mcp__void-os__vault_move",
      "mcp__void-os__ask_user",
      "mcp__void-os__ask_agent",
    ]);
  });

  test("ALLOWED_TOOLS is readonly + frozen", () => {
    expect(Object.isFrozen(ALLOWED_TOOLS)).toBe(true);
  });

  test("ALLOWED_MCP_SERVERS lists void-os only", () => {
    expect(ALLOWED_MCP_SERVERS).toEqual(["void-os"]);
    expect(Object.isFrozen(ALLOWED_MCP_SERVERS)).toBe(true);
  });

  test("mcpToolNameFor: dotted registered name -> CC-emitted name", () => {
    expect(mcpToolNameFor("void-os", "vault.read")).toBe("mcp__void-os__vault_read");
    expect(mcpToolNameFor("void-os", "ask_user")).toBe("mcp__void-os__ask_user");
    expect(mcpToolNameFor("void-os", "ask_agent")).toBe("mcp__void-os__ask_agent");
    expect(mcpToolNameFor("void-os", "a.b.c")).toBe("mcp__void-os__a_b_c");
  });
});

describe("VOS-122 F7: per-spawn tool allowlist gated by agent.md tools:", () => {
  beforeEach(() => {
    _resetLegacyToolsWarnedForTests();
  });

  test("ALLOWED_BUILTIN_TOOLS + ALLOWED_MCP_TOOLS_VOID_OS reproduce ALLOWED_TOOLS", () => {
    const expected = [
      ...ALLOWED_BUILTIN_TOOLS,
      ...ALLOWED_MCP_TOOLS_VOID_OS.map((t) => mcpToolNameFor("void-os", t)),
    ];
    expect([...ALLOWED_TOOLS]).toEqual(expected);
  });

  test("computeEffectiveTools: declared subset filters MCP, keeps built-ins", () => {
    const tools = computeEffectiveTools("tinker", [
      "vault.read",
      "vault.create",
      "ask_user",
    ]);
    // built-ins all present
    for (const b of ALLOWED_BUILTIN_TOOLS) expect(tools).toContain(b);
    // declared MCP present
    expect(tools).toContain("mcp__void-os__vault_read");
    expect(tools).toContain("mcp__void-os__vault_create");
    expect(tools).toContain("mcp__void-os__ask_user");
    // undeclared MCP absent — this is the load-bearing guarantee
    expect(tools).not.toContain("mcp__void-os__ask_agent");
    expect(tools).not.toContain("mcp__void-os__vault_delete");
  });

  test("computeEffectiveTools: declared full set === maximal set", () => {
    const tools = computeEffectiveTools("any", [...ALLOWED_MCP_TOOLS_VOID_OS]);
    expect([...tools]).toEqual([...ALLOWED_TOOLS]);
  });

  test("computeEffectiveTools: empty declared list => zero MCP tools, built-ins kept", () => {
    const tools = computeEffectiveTools("locked", []);
    expect(tools).toEqual([...ALLOWED_BUILTIN_TOOLS]);
    expect(tools.some((t) => t.startsWith("mcp__"))).toBe(false);
  });

  test("computeEffectiveTools: undeclared (legacy) => maximal set + one-shot warn", () => {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { seen.push(String(a[0])); };
    try {
      const a = computeEffectiveTools("legacy", undefined);
      const b = computeEffectiveTools("legacy", undefined);
      expect([...a]).toEqual([...ALLOWED_TOOLS]);
      expect([...b]).toEqual([...ALLOWED_TOOLS]);
      // Warning fires once per agent name across the daemon lifetime
      const matches = seen.filter((m) => m.includes(`agent "legacy"`));
      expect(matches.length).toBe(1);
    } finally {
      console.warn = orig;
    }
  });

  test("computeEffectiveTools: unknown declared names dropped silently", () => {
    // tinker's pre-F7 frontmatter listed `vault.write` and `vault.list`, neither
    // of which maps to a real MCP tool. They should be filtered, not crashed on.
    const tools = computeEffectiveTools("tinker", [
      "vault.read",
      "vault.write", // not a real tool
      "vault.list",  // not a real tool
      "ask_user",
    ]);
    expect(tools).toContain("mcp__void-os__vault_read");
    expect(tools).toContain("mcp__void-os__ask_user");
    expect(tools).not.toContain("mcp__void-os__vault_write");
    expect(tools).not.toContain("mcp__void-os__vault_list");
    expect(tools).not.toContain("mcp__void-os__ask_agent");
  });

  test("buildSpawnSettings: returns toolsArg reflecting declaredTools intersection", () => {
    const dir = mkdtempSync(join(tmpdir(), "vos-122-"));
    const built = buildSpawnSettings({
      agentName: "tinker",
      scopes: { readPaths: [], writePaths: [] },
      systemDeny: [],
      vaultRoot: "/vault",
      daemonBase: "http://127.0.0.1:8729",
      runId: "R-1",
      taskId: "T-1",
      contextId: "C-1",
      settingsDir: dir,
      hookScriptPath: "/hook.ts",
      declaredTools: ["vault.read", "ask_user"],
    });
    expect(built.toolsArg).toContain("mcp__void-os__vault_read");
    expect(built.toolsArg).toContain("mcp__void-os__ask_user");
    expect(built.toolsArg).not.toContain("mcp__void-os__ask_agent");
    expect(built.toolsArg).toContain("Bash"); // built-in preserved
  });

  test("buildSpawnSettings: declaredTools omitted => maximal (legacy) toolsArg", () => {
    const dir = mkdtempSync(join(tmpdir(), "vos-122-legacy-"));
    const orig = console.warn;
    console.warn = () => {};
    try {
      const built = buildSpawnSettings({
        agentName: "no-tools-declared",
        scopes: { readPaths: [], writePaths: [] },
        systemDeny: [],
        vaultRoot: "/vault",
        daemonBase: "http://127.0.0.1:8729",
        runId: "R-2",
        taskId: "T-2",
        contextId: "C-2",
        settingsDir: dir,
        hookScriptPath: "/hook.ts",
      });
      expect([...built.toolsArg]).toEqual([...ALLOWED_TOOLS]);
    } finally {
      console.warn = orig;
    }
  });
});
