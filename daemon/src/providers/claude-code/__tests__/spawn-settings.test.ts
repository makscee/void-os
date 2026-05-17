import { describe, expect, it, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALLOWED_MCP_SERVERS,
  ALLOWED_TOOLS,
  buildSpawnSettings,
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
    expect(settings.permissions).toEqual({ deny: ["AskUserQuestion"] });
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
