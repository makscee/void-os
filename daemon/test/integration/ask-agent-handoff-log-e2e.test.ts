// VOS-159: end-to-end ask_agent dispatch chain with a REAL handoff-log writer.
//
// VOS-154 unit-tested the handoff-log adapter (handoff-log.test.ts) and the
// ask_agent <-> handoffLog wiring with a stub (ask-agent-handoff-log.test.ts).
// This test closes the loop the operator asked for in VOS-159: boot an
// in-process daemon wired with a REAL `makeHandoffLog` pointed at the actual
// hub-side `hl` CLI, run a maya -> journaler ask_agent chain over the real MCP
// HTTP transport, and assert that a dispatch + a return entry physically land
// in <hubRoot>/vault/work/handoffs/log.jsonl.
//
// The hl CLI is bash + jq + shasum. If those tools are unavailable the test
// skips rather than failing (CI image parity, see beforeAll guard).
//
// What this proves over the stub test:
//   - the adapter shells out to a real binary with HUB_ROOT honoured
//   - hl actually appends valid JSONL
//   - bundle tempfile write + content-addressed bundle storage works
//   - return entries link to dispatch entries by parent_handoff_id

import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootInProcessDaemon, type BootedDaemon } from "../helpers/boot-daemon.ts";
import { makeHandoffLog } from "../../src/agents/handoff-log.ts";

// Locate the hub-side `hl` binary. The void-os repo canonically lives at
// hub/workspace/void-os, but tests may run from a detached git worktree
// (~/void-os-wt/<ID>/) where the hub parent is NOT reachable by a relative
// path. Resolution order:
//   1. VOID_OS_HL_PATH env override (explicit, used by CI / smoke harness).
//   2. hub-relative path from a non-worktree checkout (../../tools/...).
//   3. $HOME/hub/tools/handoff-log/hl — the standard operator hub clone.
function locateHl(): string | null {
  const candidates = [
    process.env.VOID_OS_HL_PATH,
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "tools",
      "handoff-log",
      "hl",
    ),
    join(homedir(), "hub", "tools", "handoff-log", "hl"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

let booted: BootedDaemon | null = null;
let server: { stop: () => void; port: number } | null = null;
let toolsAvailable = false;
let hlPath: string | null = null;

beforeAll(() => {
  // hl needs jq + shasum on PATH, and the binary itself must be locatable
  // (it lives in a hub clone; a bare void-os checkout without the hub parent
  // would not have it). Skip gracefully if any precondition is missing.
  hlPath = locateHl();
  if (!hlPath) return;
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    execFileSync("shasum", ["--version"], { stdio: "ignore" });
    toolsAvailable = true;
  } catch {
    toolsAvailable = false;
  }
});

afterEach(() => {
  if (server) {
    server.stop();
    server = null;
  }
  if (booted) {
    booted.close();
    booted = null;
  }
});

function bindToPort(app: Hono): { stop: () => void; port: number } {
  const srv = Bun.serve({ port: 0, fetch: app.fetch });
  return { stop: () => srv.stop(true), port: srv.port as number };
}

describe("VOS-159: ask_agent -> real handoff-log e2e", () => {
  test("dispatch + return entries land in vault/work/handoffs/log.jsonl", async () => {
    if (!toolsAvailable || !hlPath) {
      // hl / jq / shasum not present — skip without failing CI.
      console.warn(
        "[VOS-159 e2e] hl binary or jq/shasum unavailable — skipping",
      );
      return;
    }

    // ── 1. Temp HUB_ROOT — hl writes log.jsonl + bundles/ under here. ──
    const hubRoot = mkdtempSync(join(tmpdir(), "vos159-hubroot-"));
    const handoffLog = makeHandoffLog({ hlPath, hubRoot });
    const logPath = join(hubRoot, "vault", "work", "handoffs", "log.jsonl");

    // ── 2. Per-agent fake-provider scripts (mirrors ask-agent.test.ts). ──
    const tmp = mkdtempSync(join(tmpdir(), "vos159-scripts-"));
    const mayaScript = join(tmp, "maya.jsonl");
    const journScript = join(tmp, "journaler.jsonl");
    writeFileSync(
      mayaScript,
      [
        JSON.stringify({ type: "system", session_id: "sid-maya-159" }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "asking journaler... " },
              {
                type: "tool_use",
                id: "tu-ask-159",
                name: "ask_agent",
                input: {
                  target_agent_id: "journaler",
                  message: "summarise the day",
                },
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      journScript,
      [
        JSON.stringify({ type: "system", session_id: "sid-journ-159" }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "journaler day summary." }],
          },
        }),
      ].join("\n") + "\n",
    );

    // ── 3. Boot in-process daemon with the REAL handoff-log adapter. ──
    booted = await bootInProcessDaemon({
      agentScripts: { maya: mayaScript, journaler: journScript },
      parentPerEventDelayMs: 50,
      handoffLog,
      sessionId: "wm-vos159/1",
      milestone: "dogfood-void-os-workflow",
    });
    server = bindToPort(booted.app);

    // ── 4. Play the CC-runtime role: on chat.tool_use{ask_agent} issue the
    //      real MCP ask_agent call (mirrors ask-agent.test.ts). ──
    const askPromises = new Map<string, Promise<unknown>>();
    booted.bus.subscribe("chat.tool_use", (ev) => {
      const p = ev.payload as
        | {
            name?: string;
            tool_call_id?: string;
            chat_id?: string;
            input?: Record<string, unknown>;
          }
        | undefined;
      if (!p || p.name !== "ask_agent" || !p.tool_call_id) return;
      const parentTaskRow = booted!.db
        .query(
          "SELECT id FROM tasks WHERE context_id=? AND parent_task_id IS NULL ORDER BY created_at ASC LIMIT 1",
        )
        .get(p.chat_id!) as { id: string };
      askPromises.set(
        p.tool_call_id!,
        callAskAgentOverMcp({
          port: server!.port,
          taskId: parentTaskRow.id,
          contextId: p.chat_id!,
          targetAgentId: String(p.input?.target_agent_id ?? ""),
          message: String(p.input?.message ?? ""),
        }),
      );
    });

    // ── 5. Drive the chat + await the ask_agent chain. ──
    const chatId = await booted.sendUserMessage({ agent: "maya", text: "hi" });
    const t0 = Date.now();
    while (askPromises.size === 0 && Date.now() - t0 < 5_000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(askPromises.size).toBeGreaterThan(0);
    await Promise.all(askPromises.values());
    await booted.awaitChatComplete(chatId, { timeoutMs: 5_000 });

    // ── 6. Assert the JSONL log on disk. ──
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const dispatch = lines.find((e) => e.kind === "dispatch");
    const ret = lines.find((e) => e.kind === "return");
    expect(dispatch).toBeTruthy();
    expect(ret).toBeTruthy();

    // Dispatch: parent maya -> child journaler.
    expect(String(dispatch!.from_agent_id)).toMatch(/^maya:/);
    expect(String(dispatch!.to_agent_id)).toMatch(/^journaler:/);
    expect(dispatch!.task_id).toBeTruthy();
    expect(dispatch!.milestone).toBe("dogfood-void-os-workflow");
    expect(dispatch!.session).toBe("wm-vos159/1");
    // hl content-addresses the bundle text.
    expect(dispatch!.bundle_sha256).toBeTruthy();

    // Return: swapped direction, DONE on COMPLETED child, linked to dispatch.
    expect(String(ret!.from_agent_id)).toMatch(/^journaler:/);
    expect(String(ret!.to_agent_id)).toMatch(/^maya:/);
    expect(ret!.return_status).toBe("DONE");
    expect(ret!.parent_handoff_id).toBe(dispatch!.id);
  }, 20_000);
});

/**
 * Issue a real MCP ask_agent tool call against the in-process daemon.
 * Mirrors callAskAgentOverMcp in ask-agent.test.ts — one client per call.
 */
async function callAskAgentOverMcp(args: {
  port: number;
  taskId: string;
  contextId: string;
  targetAgentId: string;
  message: string;
}): Promise<unknown> {
  const client = new Client({ name: "vos159-e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${args.port}/mcp?agent=maya`),
  );
  await client.connect(transport);
  try {
    return await client.callTool({
      name: "ask_agent",
      arguments: {
        target_agent_id: args.targetAgentId,
        message: args.message,
      },
      _meta: {
        task_id: args.taskId,
        context_id: args.contextId,
        tool_call_id: `vos159-e2e-tc-${args.taskId}`,
      },
    });
  } finally {
    await client.close();
  }
}
