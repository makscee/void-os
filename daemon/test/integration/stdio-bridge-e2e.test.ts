// VOS-112 T8: real stdio-bridge subprocess <-> daemon /mcp integration.
//
// Spawns the actual `stdio-bridge.ts` as a subprocess with controlled env,
// drives JSON-RPC over its stdio, asserts the daemon-side MCP handler
// observed env-derived `_meta.task_id` / `_meta.context_id` for both
// `ask_user` (AC-1) and `ask_agent` (AC-2). AC-6 asserts the bridge exits
// non-zero and writes BRIDGE_CONFIG_FAIL on stdout when required env is
// missing.
//
// Helper-light: rather than building a dedicated `start-test-daemon`
// scaffold, we lean on production `buildApp` directly (matches the existing
// `dispatch-child.test.ts` pattern). Tasks + contexts + agent_cards are
// seeded per-subtest so the ask_user / ask_agent handlers see consistent
// state. dispatchChildTask "spy" is observed via the child task row in
// DB (the value-equivalent of the plan's injected spy — same observation
// surface).

import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations.ts";
import { buildApp } from "../../src/app.ts";

const BRIDGE = resolve(import.meta.dir, "..", "..", "src", "adapters", "mcp", "stdio-bridge.ts");
const MIGRATIONS_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

interface BootedDaemon {
  db: Database;
  port: number;
  stop: () => void;
}

const envBackup: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  process.env[key] = value;
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(envBackup)) delete envBackup[k];
}

async function bootDaemon(): Promise<BootedDaemon> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);

  const vaultRoot = mkdtempSync(join(tmpdir(), "vos112-t8-vault-"));
  mkdirSync(join(vaultRoot, "agents"), { recursive: true });

  const app = await buildApp({
    db,
    vaultRoot,
    chatCwd: vaultRoot,
    defaultAgent: "maya",
  });
  const srv = Bun.serve({ port: 0, fetch: app.fetch });
  return {
    db,
    port: srv.port as number,
    stop: () => srv.stop(true),
  };
}

/** Read JSON-RPC framed lines from the bridge's stdout. Returns the first
 *  reply whose `id` matches `expectedId`. */
function readReply(
  child: ChildProcessWithoutNullStreams,
  expectedId: number | string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.id === expectedId) {
          child.stdout.off("data", onData);
          clearTimeout(timer);
          res(parsed);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      rej(new Error(`bridge reply timeout (id=${expectedId}); buf=${buf.slice(0, 500)}`));
    }, timeoutMs);
    child.stdout.on("data", onData);
  });
}

function writeMsg(child: ChildProcessWithoutNullStreams, msg: object): void {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

let booted: BootedDaemon | null = null;
let child: ChildProcessWithoutNullStreams | null = null;

afterEach(() => {
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    child = null;
  }
  if (booted) {
    booted.stop();
    booted.db.close();
    booted = null;
  }
  restoreEnv();
});

describe("VOS-112 T8: stdio-bridge subprocess <-> daemon /mcp", () => {
  test("AC-1: ask_user receives env-derived task_id and resolves via /answer", async () => {
    booted = await bootDaemon();
    const { db, port } = booted;

    // Seed minimal state for ask_user: context + WORKING task.
    const contextId = "C-AC1";
    const taskId = "T-AC1";
    const now = Math.floor(Date.now() / 1000);
    db.run(
      "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      ["maya", JSON.stringify({ name: "maya" })],
    );
    db.run(
      `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at)
         VALUES (?, 'maya', 0, ?, ?)`,
      [contextId, now, now],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, parent_task_id, state,
                          cost_usd, tokens_in, tokens_out, metadata,
                          created_at, updated_at)
         VALUES (?, ?, NULL, 'TASK_STATE_WORKING', 0, 0, 0, '{}', ?, ?)`,
      [taskId, contextId, now, now],
    );

    // Spawn the real bridge subprocess. VOS_RUN_ID intentionally omitted —
    // messages.run_id has a FK to runs(id); without a seeded run row we let
    // the bridge resolve runId=null so the tool_use message insert succeeds.
    child = spawn(
      process.execPath,
      [BRIDGE],
      {
        env: {
          ...process.env,
          VOS_DAEMON_BASE: `http://127.0.0.1:${port}`,
          VOS_AGENT: "maya",
          VOS_TASK_ID: taskId,
          VOS_CONTEXT_ID: contextId,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;

    // Capture stderr for diagnostics on failure (no assertions on it).
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

    // 1. initialize handshake.
    writeMsg(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vos112-t8", version: "0.0.0" },
      },
    });
    const initReply = await readReply(child, 1, 5_000);
    expect(initReply.error).toBeUndefined();

    // 2. tools/call ask_user. The bridge stamps _meta.task_id from env.
    // We include a _vos_tool_use_id so we can resolve via the /answer
    // route deterministically (the handler honors this hint).
    const toolUseId = "tuid-ac1";
    writeMsg(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ask_user",
        arguments: { question: "ping?" },
        _meta: { _vos_tool_use_id: toolUseId },
      },
    });

    // Poll the DB until the task has been parked into INPUT_REQUIRED with
    // our toolUseId — proves the daemon-side handler saw _meta.task_id.
    const deadline = Date.now() + 3_000;
    let parked: { state: string; pending: string | null } | undefined;
    while (Date.now() < deadline) {
      const row = db
        .query(
          "SELECT state, json_extract(metadata, '$.pending_tool_use_id') AS pending FROM tasks WHERE id = ?",
        )
        .get(taskId) as { state: string; pending: string | null } | undefined;
      if (row && row.state === "TASK_STATE_INPUT_REQUIRED" && row.pending === toolUseId) {
        parked = row;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!parked) {
      const cur = db
        .query("SELECT state, metadata FROM tasks WHERE id = ?")
        .get(taskId);
      throw new Error(
        `ask_user did not park task; current_row=${JSON.stringify(cur)}; stderr=${stderr.slice(0, 500)}`,
      );
    }
    expect(parked.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(parked.pending).toBe(toolUseId);

    // 3. Attach the reply listener BEFORE POSTing /answer — see AC-4 for the
    //    same pattern. The bridge writes the tool reply to stdout the moment
    //    the daemon resolves the open() Promise, which can happen on the same
    //    event-loop tick as the fetch() promise resolving. If we only attach
    //    the listener AFTER `await fetch(...)`, the underlying pipe's buffered
    //    data can arrive between fetch resolution and listener attach, get
    //    dropped (no listener = stream paused, but Node's stream resume after
    //    re-attach isn't always synchronous on macOS), and the test flakes
    //    at the 5s timeout with `buf=`. Empirically AC-1 alone flaked ~4/10
    //    on this race; AC-4 was already correct.
    const replyP = readReply(child, 2, 10_000) as Promise<{
      result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
      error?: unknown;
    }>;

    // 4. Resolve via the daemon's /answer route (production path).
    const ansRes = await fetch(
      `http://127.0.0.1:${port}/chat/${contextId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool_use_id: toolUseId, answer: "pong" }),
      },
    );
    expect(ansRes.status).toBe(200);

    // 5. Bridge should now deliver the tool reply.
    const reply = await replyP;
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).toBeFalsy();
    expect(reply.result?.content?.[0]?.text).toBe("pong");
  }, 15_000);

  test("AC-2: ask_agent receives env-derived task_id and dispatches child", async () => {
    // Wire fake providers so the dispatched child can actually run.
    const tmp = mkdtempSync(join(tmpdir(), "vos112-t8-ac2-"));
    const bobScript = join(tmp, "bob.jsonl");
    writeFileSync(
      bobScript,
      [
        JSON.stringify({ type: "system", session_id: "sid-bob" }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "bob-reply" }],
          },
        }),
      ].join("\n") + "\n",
    );
    setEnv("VOS_PROVIDER", "fake");
    setEnv("VOS_FAKE_SCRIPT_bob", bobScript);
    setEnv("VOS_FAKE_SCRIPT_maya", bobScript);
    setEnv("VOS_TITLER", "stub");

    booted = await bootDaemon();
    const { db, port } = booted;

    const contextId = "C-AC2";
    const taskId = "T-AC2";
    const now = Math.floor(Date.now() / 1000);
    db.run(
      "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      ["maya", JSON.stringify({ name: "maya", ask_agent_allow: ["bob"] })],
    );
    db.run(
      "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      ["bob", JSON.stringify({ name: "bob" })],
    );
    db.run(
      `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at)
         VALUES (?, 'maya', 0, ?, ?)`,
      [contextId, now, now],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, parent_task_id, state,
                          cost_usd, tokens_in, tokens_out, metadata,
                          created_at, updated_at)
         VALUES (?, ?, NULL, 'TASK_STATE_WORKING', 0, 0, 0, '{}', ?, ?)`,
      [taskId, contextId, now, now],
    );

    child = spawn(
      process.execPath,
      [BRIDGE],
      {
        env: {
          ...process.env,
          VOS_DAEMON_BASE: `http://127.0.0.1:${port}`,
          VOS_AGENT: "maya",
          VOS_TASK_ID: taskId,
          VOS_CONTEXT_ID: contextId,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

    writeMsg(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vos112-t8-ac2", version: "0.0.0" },
      },
    });
    await readReply(child, 1, 5_000);

    // ask_agent requires _meta.tool_call_id (the bridge doesn't synthesize
    // it — in production it rides on the CC tool_use block). We supply it
    // explicitly in params._meta; stampMeta preserves it.
    writeMsg(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ask_agent",
        arguments: { target_agent_id: "bob", message: "hi" },
        _meta: { tool_call_id: "tc-ac2" },
      },
    });

    const reply = (await readReply(child, 2, 10_000)) as {
      result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
      error?: unknown;
    };
    expect(reply.error).toBeUndefined();
    if (reply.result?.isError) {
      throw new Error(
        `ask_agent returned isError=true: ${JSON.stringify(reply.result)}; stderr=${stderr.slice(0, 500)}`,
      );
    }
    expect(reply.result?.content?.[0]?.text).toBe("bob-reply");

    // Child task row: parent_task_id must equal our env-derived T-AC2,
    // target_agent must be "bob". This is the dispatchChildTask "spy"
    // equivalent — the production dispatcher persists these from the
    // ask_agent handler's mint, which read task_id from _meta.
    const childRow = db
      .query(
        `SELECT parent_task_id, target_agent, state
           FROM tasks
          WHERE context_id = ? AND parent_task_id IS NOT NULL`,
      )
      .get(contextId) as
      | { parent_task_id: string; target_agent: string; state: string }
      | undefined;
    expect(childRow).toBeTruthy();
    expect(childRow!.parent_task_id).toBe(taskId);
    expect(childRow!.target_agent).toBe("bob");
    expect(childRow!.state).toBe("TASK_STATE_COMPLETED");
  }, 15_000);

  test("AC-4: concurrent same-agent dispatches stay disjoint at the handler AND at resolve", async () => {
    booted = await bootDaemon();
    const { db, port } = booted;

    // Seed shared agent with TWO disjoint contexts, one WORKING task each.
    // Both bridges share VOS_AGENT; VOS_TASK_ID + VOS_CONTEXT_ID differ. The
    // /answer route resolves via openTaskFor(chat_id), which keys off
    // context_id → distinct contexts ⇒ distinct resolve paths. The handler
    // must still key its _meta on env-derived task_id per call.
    const contextA = "C-AC4-A";
    const contextB = "C-AC4-B";
    const taskA = "T-AC4-A";
    const taskB = "T-AC4-B";
    const now = Math.floor(Date.now() / 1000);
    db.run(
      "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      ["maya", JSON.stringify({ name: "maya" })],
    );
    for (const [cid, tid] of [
      [contextA, taskA],
      [contextB, taskB],
    ] as const) {
      db.run(
        `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at)
           VALUES (?, 'maya', 0, ?, ?)`,
        [cid, now, now],
      );
      db.run(
        `INSERT INTO tasks (id, context_id, parent_task_id, state,
                            cost_usd, tokens_in, tokens_out, metadata,
                            created_at, updated_at)
           VALUES (?, ?, NULL, 'TASK_STATE_WORKING', 0, 0, 0, '{}', ?, ?)`,
        [tid, cid, now, now],
      );
    }

    function spawnBridge(taskId: string, contextId: string): ChildProcessWithoutNullStreams {
      return spawn(
        process.execPath,
        [BRIDGE],
        {
          env: {
            ...process.env,
            VOS_DAEMON_BASE: `http://127.0.0.1:${port}`,
            VOS_AGENT: "maya",
            VOS_TASK_ID: taskId,
            VOS_CONTEXT_ID: contextId,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      ) as ChildProcessWithoutNullStreams;
    }

    const childA = spawnBridge(taskA, contextA);
    const childB = spawnBridge(taskB, contextB);
    // Stash one in the module-level `child` so afterEach kills it; track B
    // locally and ensure cleanup at end of test (and on failure).
    child = childA;
    let stderrA = "";
    let stderrB = "";
    childA.stderr.on("data", (c) => { stderrA += c.toString("utf8"); });
    childB.stderr.on("data", (c) => { stderrB += c.toString("utf8"); });

    try {
      // 1. Initialize both bridges.
      writeMsg(childA, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vos112-t9-A", version: "0.0.0" },
        },
      });
      writeMsg(childB, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vos112-t9-B", version: "0.0.0" },
        },
      });
      const [initA, initB] = await Promise.all([
        readReply(childA, 1, 5_000),
        readReply(childB, 1, 5_000),
      ]);
      expect(initA.error).toBeUndefined();
      expect(initB.error).toBeUndefined();

      // 2. Fire ask_user on both bridges concurrently.
      const toolUseIdA = "tuid-ac4-A";
      const toolUseIdB = "tuid-ac4-B";
      writeMsg(childA, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ask_user",
          arguments: { question: "ping A?" },
          _meta: { _vos_tool_use_id: toolUseIdA },
        },
      });
      writeMsg(childB, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ask_user",
          arguments: { question: "ping B?" },
          _meta: { _vos_tool_use_id: toolUseIdB },
        },
      });
      // Bridge reply promises — created NOW so the bCall promise observes
      // any (incorrect) early resolve when we answer A.
      const aCall = readReply(childA, 2, 10_000) as Promise<{
        result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
        error?: unknown;
      }>;
      const bCall = readReply(childB, 2, 10_000) as Promise<{
        result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
        error?: unknown;
      }>;

      // 3. Poll until BOTH tasks are independently parked with the right
      //    pending tool_use_id. Proves the handler keyed off env-derived
      //    task_id per call (not cross-contaminated).
      const deadline = Date.now() + 5_000;
      let parkedA: { state: string; pending: string | null } | undefined;
      let parkedB: { state: string; pending: string | null } | undefined;
      while (Date.now() < deadline && (!parkedA || !parkedB)) {
        if (!parkedA) {
          const rA = db
            .query(
              "SELECT state, json_extract(metadata, '$.pending_tool_use_id') AS pending FROM tasks WHERE id = ?",
            )
            .get(taskA) as { state: string; pending: string | null } | undefined;
          if (rA && rA.state === "TASK_STATE_INPUT_REQUIRED" && rA.pending === toolUseIdA) {
            parkedA = rA;
          }
        }
        if (!parkedB) {
          const rB = db
            .query(
              "SELECT state, json_extract(metadata, '$.pending_tool_use_id') AS pending FROM tasks WHERE id = ?",
            )
            .get(taskB) as { state: string; pending: string | null } | undefined;
          if (rB && rB.state === "TASK_STATE_INPUT_REQUIRED" && rB.pending === toolUseIdB) {
            parkedB = rB;
          }
        }
        if (!parkedA || !parkedB) await new Promise((r) => setTimeout(r, 20));
      }
      if (!parkedA || !parkedB) {
        const curA = db.query("SELECT state, metadata FROM tasks WHERE id = ?").get(taskA);
        const curB = db.query("SELECT state, metadata FROM tasks WHERE id = ?").get(taskB);
        throw new Error(
          `concurrent park failed; A=${JSON.stringify(curA)} B=${JSON.stringify(curB)}; ` +
            `stderrA=${stderrA.slice(0, 300)}; stderrB=${stderrB.slice(0, 300)}`,
        );
      }
      // Cross-check: A's pending must NOT equal B's tool_use_id (and vice
      // versa). This is the "handler sees right id per call" assertion.
      expect(parkedA.pending).toBe(toolUseIdA);
      expect(parkedB.pending).toBe(toolUseIdB);
      expect(parkedA.pending).not.toBe(toolUseIdB);
      expect(parkedB.pending).not.toBe(toolUseIdA);

      // 4. Resolve ONLY task A. aCall must deliver "answer-A"; bCall must
      //    remain pending (race vs 200ms timeout).
      const ansARes = await fetch(
        `http://127.0.0.1:${port}/chat/${contextA}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool_use_id: toolUseIdA, answer: "answer-A" }),
        },
      );
      expect(ansARes.status).toBe(200);

      const aReply = await aCall;
      expect(aReply.error).toBeUndefined();
      expect(aReply.result?.isError).toBeFalsy();
      expect(aReply.result?.content?.[0]?.text).toBe("answer-A");

      // bCall must NOT resolve. Race it against a 200ms timeout sentinel.
      const sentinel = new Promise<"pending">((r) => setTimeout(() => r("pending"), 200));
      const raced = await Promise.race([
        bCall.then((v) => ({ kind: "resolved" as const, v })),
        sentinel.then(() => "pending" as const),
      ]);
      expect(raced).toBe("pending");

      // 5. Now resolve task B → bCall delivers "answer-B".
      const ansBRes = await fetch(
        `http://127.0.0.1:${port}/chat/${contextB}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool_use_id: toolUseIdB, answer: "answer-B" }),
        },
      );
      expect(ansBRes.status).toBe(200);

      const bReply = await bCall;
      expect(bReply.error).toBeUndefined();
      expect(bReply.result?.isError).toBeFalsy();
      expect(bReply.result?.content?.[0]?.text).toBe("answer-B");
    } finally {
      // 6. Kill both bridges. childA is also cleaned by afterEach via
      //    module-level `child`; childB needs explicit cleanup.
      try {
        childB.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }, 20_000);

  test("AC-6: missing required env -> exit 1 with BRIDGE_CONFIG_FAIL on stdout", async () => {
    // Strip the required env so validateBridgeEnv fails.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    delete env.VOS_DAEMON_BASE;
    delete env.VOS_TASK_ID;
    env.VOS_AGENT = "maya";

    const proc = spawn(process.execPath, [BRIDGE], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>(
      (res) => {
        let buf = "";
        proc.stdout.on("data", (c) => { buf += c.toString("utf8"); });
        proc.on("exit", (c) => res({ stdout: buf, code: c }));
      },
    );

    expect(code).toBe(1);
    expect(stdout).toMatch(/BRIDGE_CONFIG_FAIL/);
    // Confirm it's a valid JSON-RPC error envelope.
    const firstLine = stdout.trim().split("\n")[0]!;
    const parsed = JSON.parse(firstLine) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string; data: { kind: string } };
    };
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.error.data.kind).toBe("BRIDGE_CONFIG_FAIL");
  }, 10_000);
});
