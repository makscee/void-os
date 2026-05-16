// VOS-89 T15: integration test — maya → journaler ask_agent end-to-end.
//
// Boots an in-process daemon (helper) with fake providers for two agents,
// then exercises the ask_agent flow. Validates the four contract assertions
// from the plan:
//   1. parent task reaches TASK_STATE_COMPLETED
//   2. child task reaches TASK_STATE_COMPLETED
//   3. child.parent_task_id === parent.id
//   4. child.context_id === parent.context_id
//
// What the test simulates that production does not:
//
// The real production wire is: claude-code subprocess emits a tool_use
// frame; the CC client invokes the MCP server's `ask_agent` tool over
// Streamable HTTP; the ask_agent handler mints the child + parks the parent. The
// fake provider in this harness does NOT call back into the MCP server —
// it just emits canned events. So the test plays the LLM-runtime role:
// it watches `chat.tool_use` events on the bus, and when it sees an
// `ask_agent` invocation it calls the MCP `ask_agent` tool over the
// real Streamable HTTP transport, just like a real CC subprocess would.
// Everything DOWNSTREAM of that call (mint child / dispatch / wait /
// resume parent / translate result) is real production code from
// daemon/src/adapters/mcp/tools/ask-agent*.ts and daemon/src/chat/
// orchestrator.ts.
//
// Schema deviations from the plan (T15 step 1 SQL):
// - The plan's SELECT uses `tasks.agent_name`, but `tasks` has no such
//   column (verified migrations 0007 + 0010 + 0011). Caller agent
//   identity = `contexts.agent_name`; child agent = `tasks.target_agent`
//   (added in 0011). The assertions below filter accordingly.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootInProcessDaemon, type BootedDaemon } from "../helpers/boot-daemon.ts";

let booted: BootedDaemon | null = null;
let server: { stop: () => void; port: number } | null = null;
let mcpClient: Client | null = null;

afterEach(async () => {
  if (mcpClient) {
    try {
      await mcpClient.close();
    } catch {
      /* ignore */
    }
    mcpClient = null;
  }
  if (server) {
    server.stop();
    server = null;
  }
  if (booted) {
    booted.close();
    booted = null;
  }
});

/**
 * Bind the booted daemon's app to a random port so the MCP HTTP transport
 * has a real URL to talk to. (mountMcp runs over Hono; the StreamableHTTP
 * server-side handler reads/writes Node-shaped req/res via honoBridge,
 * which only works against a live HTTP server, not app.request().)
 */
function bindToPort(app: Hono): { stop: () => void; port: number } {
  const srv = Bun.serve({ port: 0, fetch: app.fetch });
  return {
    stop: () => srv.stop(true),
    port: srv.port as number,
  };
}

describe("ask_agent integration (maya -> journaler via fake providers)", () => {
  // VOS-97 T6: ids now travel on `params._meta` (per ADR-0002 §"Caller-side
  // _meta injection"). The MCP SDK Client.callTool forwards the full params
  // shape into the JSON-RPC envelope; the SDK server-side transport parses
  // it out into RequestHandlerExtra._meta. The hono bridge is a byte pipe.
  test("happy path child completes, parent resumes", async () => {
    // ── 1. Per-agent fake-provider scripts ────────────────────────────
    // maya emits a system handshake (so session_id is captured) + an
    // assistant turn carrying both narrative text AND a tool_use block
    // for ask_agent. The narrative text + tool_use go through the
    // orchestrator's normal extract path. perEventDelayMs gives us a
    // beat between events so the test-side bus subscriber can react to
    // the chat.tool_use frame BEFORE maya's run finishes (otherwise the
    // run would terminate, the parent task would COMPLETE, and there'd
    // be no parent left to flip into WAITING_ON_AGENT).
    const tmp = mkdtempSync(join(tmpdir(), "vos89-t15-"));
    const mayaScript = join(tmp, "maya.jsonl");
    const journScript = join(tmp, "journaler.jsonl");
    writeFileSync(
      mayaScript,
      [
        JSON.stringify({ type: "system", session_id: "sid-maya-1" }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "asking journaler... " },
              {
                type: "tool_use",
                id: "tu-ask-1",
                name: "ask_agent",
                input: { target_agent_id: "journaler", message: "summarise" },
              },
            ],
          },
        }),
        // No follow-up assistant turn: in production the CC subprocess
        // would block AWAITING the MCP ask_agent result before emitting
        // anything else. The fake provider can't actually pause, so we
        // just end the script after tool_use. This forces the parent's
        // first run to finish (run.end fires) while the parent task is
        // already WAITING_ON_AGENT — the orchestrator's terminal-flip
        // CAS sees state != WORKING and rejects, leaving the parent
        // parked. When the child later terminates,
        // resumeParentOnChildTerminal fires the WORKING+COMPLETED settle
        // (chat has no current_run_id at that point because the run
        // ended). This exercises path (b) of the T15.5 wiring; path (a)
        // is exercised by orchestrator-level unit tests.
      ].join("\n") + "\n",
    );
    writeFileSync(
      journScript,
      [
        JSON.stringify({ type: "system", session_id: "sid-journ-1" }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "journaler summary." }],
          },
        }),
      ].join("\n") + "\n",
    );

    // ── 2. Boot the in-process daemon with both agents wired ──────────
    booted = await bootInProcessDaemon({
      agentScripts: { maya: mayaScript, journaler: journScript },
      // 50ms between maya's events keeps the parent run alive long
      // enough for the test bus subscriber to observe chat.tool_use,
      // dispatch the MCP ask_agent call (HTTP roundtrip + mint), and
      // park the parent in WAITING_ON_AGENT BEFORE the run drains.
      // Without this the parent's run.end races ahead of the MCP call
      // and flips the parent to COMPLETED, after which mintChildAndFlipParent's
      // CAS rejects (parent no longer WORKING).
      parentPerEventDelayMs: 50,
    });
    server = bindToPort(booted.app);

    // ── 3. Watch the bus for the ask_agent tool_use, then call it ─────
    // Production: the CC subprocess sees its own tool_use stream and
    // invokes MCP. Here, the test plays that role: when the orchestrator
    // emits chat.tool_use{name:"ask_agent"} we issue the real MCP call
    // (which lands in the ask_agent handler, mints the child, parks the parent,
    // dispatches journaler via dispatchChildTask, and resolves on child
    // terminal). We track the call promise so we can await its resolution
    // and assert it returned the journaler's text.
    const askPromisesByToolCallId = new Map<string, Promise<unknown>>();
    booted.bus.subscribe("chat.tool_use", (ev) => {
      const p = ev.payload as
        | { name?: string; tool_call_id?: string; input?: Record<string, unknown> }
        | undefined;
      if (!p || p.name !== "ask_agent" || !p.tool_call_id) return;
      // Resolve the parent task id from the chat (= context) id; the
      // payload from chat.tool_use carries chat_id only.
      const chatId = (ev.payload as { chat_id?: string }).chat_id!;
      const parentTaskRow = booted!.db
        .query(
          "SELECT id FROM tasks WHERE context_id=? AND parent_task_id IS NULL ORDER BY created_at ASC LIMIT 1",
        )
        .get(chatId) as { id: string };
      askPromisesByToolCallId.set(
        p.tool_call_id!,
        callAskAgentOverMcp({
          port: server!.port,
          taskId: parentTaskRow.id,
          contextId: chatId,
          targetAgentId: String(p.input?.target_agent_id ?? ""),
          message: String(p.input?.message ?? ""),
        }),
      );
    });

    // ── 4. Drive a chat through maya. The dispatch returns once maya's
    //      fake provider drains; ask_agent fires concurrently from the
    //      bus subscriber above, blocks the maya run only if the
    //      orchestrator awaits on it (it does not — chat.tool_use is
    //      fire-and-forget WS frame), but DOES park the parent task in
    //      WAITING_ON_AGENT, which the resume listener flips back to
    //      WORKING when the child completes.
    const chatId = await booted.sendUserMessage({ agent: "maya", text: "hi" });

    // ── 5. Wait for the ask_agent MCP call to resolve (= journaler done
    //      and translated). Then wait for the parent task to reach a
    //      terminal state. The chat dispatch run already ended (provider
    //      stream drained), so the parent task ends as COMPLETED via the
    //      orchestrator's task-state pipeline only IF something flips it.
    //      In the current wiring, the orchestrator does NOT auto-flip
    //      task state to COMPLETED on run.end — it leaves the task in
    //      WORKING/INPUT_REQUIRED/WAITING_ON_AGENT. For T15 we mark the
    //      parent COMPLETED ourselves once ask_agent resolved AND the
    //      run ended; this matches the eventual production wiring (the
    //      orchestrator will own this in a follow-up task — call it out
    //      explicitly in the assertions below).
    //
    // Wait for at least one ask_agent call to land + resolve.
    const t0 = Date.now();
    while (askPromisesByToolCallId.size === 0 && Date.now() - t0 < 5_000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(askPromisesByToolCallId.size).toBeGreaterThan(0);
    const askResults = await Promise.all(askPromisesByToolCallId.values());
    expect(askResults.length).toBe(1);
    // The MCP tool result is { content: [{type:"text", text:"journaler summary."}] }.
    const r0 = askResults[0] as { content: Array<{ type: string; text: string }> };
    expect(r0.content[0]!.type).toBe("text");
    expect(r0.content[0]!.text).toBe("journaler summary.");

    // ── 6. Wait for the parent to settle. The production wiring (T15.5)
    //      flips the parent task to TASK_STATE_COMPLETED via TWO trigger
    //      points:
    //        (a) orchestrator finally block on run.end — but T15's fake
    //            maya script drains BEFORE ask_agent resolves, so at
    //            that moment the parent is still WAITING_ON_AGENT and
    //            the run.end flip is rejected by the WORKING-only CAS.
    //        (b) resumeParentOnChildTerminal — when the child finishes
    //            it flips parent WAITING→WORKING, then because the
    //            chat has no current_run_id (run already cleaned up)
    //            it immediately tries the WORKING→COMPLETED flip.
    //      So the COMPLETED flip happens via path (b) here. We poll the
    //      parent state because the child terminal → resume → completion
    //      chain is all synchronous emit-driven, but the test's MCP
    //      callTool roundtrip is async: by the time we get here the
    //      flip MAY already have happened (queueMicrotask + sync
    //      bus listeners) but we don't depend on that ordering.
    await booted.awaitChatComplete(chatId, { timeoutMs: 5_000 });

    // ── 7. Assertions per plan acceptance ─────────────────────────────
    const allTasks = booted.db
      .query(
        "SELECT id, parent_task_id, context_id, state, target_agent FROM tasks WHERE context_id=? ORDER BY created_at",
      )
      .all(chatId) as Array<{
      id: string;
      parent_task_id: string | null;
      context_id: string;
      state: string;
      target_agent: string | null;
    }>;
    // Exactly one parent (maya, root) + one child (journaler).
    expect(allTasks.length).toBe(2);
    const parent = allTasks.find((t) => t.parent_task_id === null);
    const child = allTasks.find((t) => t.parent_task_id !== null);
    expect(parent).toBeTruthy();
    expect(child).toBeTruthy();
    expect(parent!.state).toBe("TASK_STATE_COMPLETED");
    expect(child!.state).toBe("TASK_STATE_COMPLETED");
    expect(child!.parent_task_id).toBe(parent!.id);
    expect(child!.context_id).toBe(parent!.context_id);
    // Child's target_agent column carries journaler (parent's agent lives
    // on contexts.agent_name).
    expect(child!.target_agent).toBe("journaler");
    const ctxRow = booted.db
      .query("SELECT agent_name FROM contexts WHERE id=?")
      .get(chatId) as { agent_name: string };
    expect(ctxRow.agent_name).toBe("maya");
  }, 15_000);
});

/**
 * Issue a real MCP ask_agent tool call against the in-process daemon.
 * Constructs a fresh Streamable HTTP client per invocation — mirrors the
 * approach taken in daemon/test/ask-user/e2e.int.test.ts (one client per
 * tool call to avoid cross-call session bleed in stateless mode).
 */
async function callAskAgentOverMcp(args: {
  port: number;
  taskId: string;
  contextId: string;
  targetAgentId: string;
  message: string;
}): Promise<unknown> {
  const client = new Client({ name: "vos89-t15-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${args.port}/mcp`),
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
      },
    });
  } finally {
    await client.close();
  }
}
