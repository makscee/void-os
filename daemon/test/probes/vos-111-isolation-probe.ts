// VOS-111 manual isolation probe. NOT part of `bun test`. Run via:
//   cd daemon && bun test/probes/vos-111-isolation-probe.ts
//
// Pins three unknowns before VOS-111 T1 begins:
//   A — flag syntax for --setting-sources (operator runs `claudev claude --help`
//       first; the chosen form is hard-coded here at SETTING_SOURCES_FLAGS).
//   B — exact MCP tool name CC emits for vault.read on McpServer void-os.
//   C — that --settings <p> is honored when --setting-sources drops `user`.
//
// The probe starts a minimal daemon-like Hono server that mounts the real
// void-os MCP adapter at /mcp (against an ephemeral SQLite + a tmpdir vault
// root with one note file), spawns `claudev claude` with the isolation flags,
// and captures CC's first `system.init` event from stdout stream-json.
//
// Side-channel for sub-assertion C: the PreToolUse hook command is replaced
// with a tiny shell script that appends to /tmp/probe-hook.log when fired.
// Presence of any line after the spawn finishes => C PASS.
//
// Cost: spawns a real claudev → real Anthropic tokens on the operator's pool.
// Prompt is intentionally short ("run `ls` and stop").

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../src/events/index.ts";
import { createAskUserBridge } from "../../src/chat/ask-user-bridge";
import { createPermissionEngine } from "../../src/permissions/engine";
import { mountMcp } from "../../src/adapters/mcp";
import { buildSpawnSettings } from "../../src/providers/claude-code/spawn-settings";

// >>> Operator: set this to the form recorded in runbook §A.
//     Pinned form (claudev 0.2.18 / Claude Code 2.1.143):
//       --setting-sources <sources>   Comma-separated list of setting
//                                      sources to load (user, project, local).
//     Single value passed. To drop `user`, pass `project` only.
const SETTING_SOURCES_FLAGS: string[] = ["--setting-sources", "project"];

// Side-channel file the PreToolUse hook script appends to.
const HOOK_LOG = "/tmp/probe-hook.log";

const MIGRATIONS = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

interface ProbeDaemon {
  base: string;
  vaultRoot: string;
  close: () => void;
}

async function bootProbeDaemon(): Promise<ProbeDaemon> {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vos-111-probe-vault-"));
  // Minimal vault content the agent can read if it wants to.
  writeFileSync(join(vaultRoot, "note.md"), "probe-note: hello vos-111\n");

  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS);

  // Seed a single permissive agent_card so the engine resolves `probe-agent`.
  const card = {
    name: "probe-agent",
    read_scope: ["**/*"],
    write_scope: ["**/*"],
  };
  db.run(
    "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
    ["probe-agent", JSON.stringify(card)],
  );

  const bus = createEventBus({ db });
  const bridge = createAskUserBridge({ db, bus });
  const engine = createPermissionEngine({
    vaultRoot,
    homeRoot: process.env.HOME ?? "",
  });

  const app = new Hono();
  mountMcp(app, { vaultRoot, db, bus, bridge, engine });

  // idleTimeout: 0 — MCP SSE/stream connections from CC must not be killed
  // mid-flight (void-os CLAUDE.md gotcha #4).
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 0 });
  const base = `http://127.0.0.1:${server.port}`;

  return {
    base,
    vaultRoot,
    close: () => {
      server.stop(true);
      db.close();
    },
  };
}

interface SystemInit {
  type: string;
  subtype: string;
  mcp_servers?: Array<Record<string, unknown> | string>;
  tools?: string[];
  [k: string]: unknown;
}

async function main(): Promise<void> {
  // Reset side-channel log so we only see hook fires from THIS run.
  if (existsSync(HOOK_LOG)) {
    try {
      unlinkSync(HOOK_LOG);
    } catch {
      /* ignore */
    }
  }

  const daemon = await bootProbeDaemon();
  const probeDir = mkdtempSync(join(tmpdir(), "vos-111-probe-"));
  const settingsDir = join(probeDir, "settings");
  mkdirSync(settingsDir, { recursive: true });

  // Write the side-channel hook script. Has to be executable; CC invokes it
  // via the `command` field of a PreToolUse hook. Use `sh` for portability.
  // The hook reads stdin (CC tool-call JSON) — we don't parse, just want
  // proof-of-execution. Always print `{"continue": true}` so the run
  // proceeds; append HOOK_FIRED <toolName-guess> to the log.
  const hookScript = join(probeDir, "hook.sh");
  writeFileSync(
    hookScript,
    `#!/bin/sh
# VOS-111 probe side-channel hook. Reads CC tool-call JSON on stdin,
# appends a HOOK_FIRED line to ${HOOK_LOG}, prints {"continue":true}.
payload=$(cat)
# Best-effort tool name extraction without jq. CC sends {"tool_name":"Bash",...}
tool=$(printf '%s' "$payload" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
[ -z "$tool" ] && tool="UNKNOWN"
echo "HOOK_FIRED $tool $(date -u +%FT%TZ)" >> ${HOOK_LOG}
printf '{"continue":true}'
exit 0
`,
  );
  chmodSync(hookScript, 0o755);

  // Use buildSpawnSettings so the wire format matches production exactly.
  // Then overwrite the settings.json's hook command to point at OUR side-
  // channel script instead of the production pre-tool-use.ts hook (we want
  // proof the hook FIRES, decoupled from the production hook's logic).
  const built = buildSpawnSettings({
    agentName: "probe-agent",
    scopes: { readPaths: [daemon.vaultRoot], writePaths: [daemon.vaultRoot] },
    systemDeny: [],
    vaultRoot: daemon.vaultRoot,
    daemonBase: daemon.base,
    runId: "probe-run",
    settingsDir,
    hookScriptPath: hookScript, // placeholder; we rewrite the command below
  });

  // Rewrite settings.json: replace the production hook command with our
  // shell script. This is the load-bearing test: CC sees a hook in the
  // file we hand it via --settings, and we observe whether CC honors it
  // when --setting-sources drops `user`.
  const settings = JSON.parse(readFileSync(built.settingsPath, "utf8"));
  settings.hooks.PreToolUse[0].hooks[0] = {
    type: "command",
    command: hookScript,
  };
  writeFileSync(built.settingsPath, JSON.stringify(settings, null, 2));

  // Spawn claudev. Short prompt that should provoke at least one Bash call.
  // No --tools — observation mode (T0 wants to SEE the full tools array CC
  // emits before T1 introduces the allowlist).
  const args: string[] = [
    "claude",
    "-p",
    // Strong, single-action prompt. Models sometimes answer "ls" textually
    // without invoking the tool; the explicit "you MUST call the Bash tool"
    // phrasing reliably forces an actual tool_use block.
    "You MUST call the Bash tool exactly once with command `ls`. Do not answer textually. After the tool returns, stop.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    ...SETTING_SOURCES_FLAGS,
    "--settings",
    built.settingsPath,
    "--mcp-config",
    built.mcpConfigPath,
  ];

  console.log(`[probe] daemon base = ${daemon.base}`);
  console.log(`[probe] vault root  = ${daemon.vaultRoot}`);
  console.log(`[probe] settings    = ${built.settingsPath}`);
  console.log(`[probe] mcp.json    = ${built.mcpConfigPath}`);
  console.log(`[probe] hook script = ${hookScript}`);
  console.log(`[probe] argv: claudev ${args.join(" ")}`);

  const child = spawn("claudev", args, {
    cwd: daemon.vaultRoot,
    env: { ...process.env, ...built.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let systemInit: SystemInit | null = null;
  const toolUses: Array<{ name?: unknown; input?: unknown }> = [];
  // Forensic log: full stream-json stdout, one line per event.
  const streamLogPath = join(probeDir, "stream-json.log");
  writeFileSync(streamLogPath, "");
  console.log(`[probe] stream log = ${streamLogPath}`);

  child.stdout.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    stdoutBuf += s;
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      // Append every line to the forensic log.
      try {
        require("node:fs").appendFileSync(streamLogPath, line + "\n");
      } catch {
        /* ignore */
      }
      try {
        const j = JSON.parse(line) as SystemInit & {
          message?: { content?: Array<Record<string, unknown>> };
        };
        if (j.type === "system" && j.subtype === "init" && !systemInit) {
          systemInit = j;
          console.log("[probe] captured system.init event");
        }
        // Walk assistant message content blocks for tool_use entries.
        const content = j.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === "object" &&
              (block as Record<string, unknown>).type === "tool_use"
            ) {
              toolUses.push({
                name: (block as Record<string, unknown>).name,
                input: (block as Record<string, unknown>).input,
              });
            }
          }
        }
      } catch {
        // Not JSON, ignore — claudev banner lines etc.
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  const exitCode: number = await new Promise((resolve) => {
    const t = setTimeout(() => {
      console.error("[probe] timeout, killing child");
      child.kill("SIGKILL");
    }, 120_000);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve(code ?? -1);
    });
  });

  console.log(`\n[probe] claudev exited with code ${exitCode}`);

  // ----- Output blocks for the runbook -----
  console.log("\n========== § B  system.init capture ==========");
  if (!systemInit) {
    console.log("FAIL: no system.init event observed on stdout.");
    console.log("--- stderr tail ---");
    console.log(stderrBuf.split("\n").slice(-40).join("\n"));
  } else {
    const mcpServers = systemInit.mcp_servers ?? [];
    const tools = systemInit.tools ?? [];
    console.log("mcp_servers:");
    console.log(JSON.stringify(mcpServers, null, 2));
    console.log("\ntools:");
    console.log(JSON.stringify(tools, null, 2));
    const voidOsTools = tools.filter((t) => t.startsWith("mcp__void-os__"));
    console.log("\nmcp__void-os__* tool names:");
    console.log(JSON.stringify(voidOsTools, null, 2));
  }

  console.log("\n========== § C  hook-fired evidence ==========");
  console.log(
    `tool_use blocks observed in assistant messages: ${toolUses.length}`,
  );
  if (toolUses.length > 0) {
    for (const t of toolUses.slice(0, 5)) {
      console.log(`  - ${String(t.name)}: ${JSON.stringify(t.input)}`);
    }
  } else {
    console.log(
      "  (model returned text without invoking any tool — hook had no chance to fire)",
    );
  }
  if (existsSync(HOOK_LOG)) {
    const log = readFileSync(HOOK_LOG, "utf8");
    if (log.trim()) {
      console.log("\nHOOK FIRED — contents of " + HOOK_LOG + ":");
      console.log(log);
    } else {
      console.log("\nEMPTY — " + HOOK_LOG + " exists but has no lines.");
    }
  } else {
    console.log("\nEMPTY — " + HOOK_LOG + " does not exist.");
  }

  console.log("\n========== probe done ==========");

  daemon.close();
  // Leave probeDir + HOOK_LOG on disk for forensic inspection.
  void rmSync; // suppress unused-import warning; keep for future cleanup
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
