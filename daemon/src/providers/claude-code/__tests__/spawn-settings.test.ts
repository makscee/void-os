import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSpawnSettings } from "../spawn-settings";

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
  });

  it("writes mcp.json pointing at /mcp?agent=<n>&run=<id>", () => {
    const dir = freshDir();
    const { mcpConfigPath } = buildSpawnSettings({
      agentName: "journaler",
      scopes: { readPaths: [`${VAULT}/journal/**`], writePaths: [`${VAULT}/journal/**`] },
      systemDeny: [],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "run-xyz",
      settingsDir: dir,
      hookScriptPath: "/abs/hook.ts",
    });
    const mcp = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    expect(mcp.mcpServers["void-os"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:17777/mcp?agent=journaler&run=run-xyz",
    });
  });

  it("env exports JSON-encoded scope arrays", () => {
    const { env } = buildSpawnSettings({
      agentName: "x",
      scopes: { readPaths: ["/r"], writePaths: ["/w"] },
      systemDeny: ["/d"],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "r",
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
      settingsDir: dir,
      hookScriptPath: "/h",
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.additionalDirectories).toEqual([]);
  });
});
