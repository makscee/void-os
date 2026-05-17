// VOS-106 T9: loader-integration probe harness. Runs six probes against
// a live in-process daemon configured with the real claude-code provider
// (no fake). Uses a write-isolated copy of daemon/test/fixtures/probe-vault.
//
// Run: bun test:probes
// Pass: ≥5/6 PASS. The single allowed FAIL is for PROBE_DESIGN_BUG only.

import { cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../src/events/index.ts";
import { createAskUserBridge } from "../../src/chat/ask-user-bridge";
import { createPermissionEngine } from "../../src/permissions/engine";
import { createVaultWriter } from "../../src/vault/writer";
import { mountMcp, defaultLoadAgentDefn } from "../../src/adapters/mcp";
import { mountAnswerRoute } from "../../src/api/answer";
import { chatsApi } from "../../src/api/chats";
import { chatApi } from "../../src/api/chat";
import { makeChatRepo } from "../../src/chat/repo";
import { makeOrchestrator } from "../../src/chat/orchestrator";
import { makeProvider } from "../../src/providers/factory";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "probe-vault");
const HOOK = join(import.meta.dir, "..", "..", "src", "providers", "claude-code", "hook-bin", "pre-tool-use.ts");
const MIGRATIONS = join(import.meta.dir, "..", "..", "src", "adapters", "sqlite", "migrations");

interface Probe {
  label: string;
  agent: string;
  prompt: string;
  expectRegex: RegExp;
  expectDesc: string;
}

const PROBES: Probe[] = [
  { label: "maya / journal-Q", agent: "maya", prompt: "what did I write in today's journal?", expectRegex: /ask_agent\s*\(\s*["']journaler/i, expectDesc: 'ask_agent("journaler"' },
  { label: "maya / next-work-Q", agent: "maya", prompt: "what should I work on next?", expectRegex: /ask_agent\s*\(\s*["']task-tracker/i, expectDesc: 'ask_agent("task-tracker"' },
  { label: "journaler / mark-done", agent: "journaler", prompt: "mark VOS-PROBE-0-fixture done", expectRegex: /ask_agent\s*\(\s*["']task-tracker/i, expectDesc: 'declines + names task-tracker' },
  { label: "journaler / log-session", agent: "journaler", prompt: "log a 30-min void-os session, debugging", expectRegex: /vault\/journal\/.*\.md/i, expectDesc: "writes inside vault/journal/" },
  { label: "task-tracker / journal-Q", agent: "task-tracker", prompt: "what's in my journal?", expectRegex: /ask_agent\s*\(\s*["']journaler/i, expectDesc: 'declines + names journaler' },
  { label: "task-tracker / promote", agent: "task-tracker", prompt: "promote VOS-PROBE-1-fixture to active", expectRegex: /\/work\s+--queue\s+VOS-PROBE-1-fixture/i, expectDesc: "/work --queue VOS-PROBE-1-fixture" },
];

async function bootProbeDaemon(): Promise<{ app: Hono; vaultRoot: string; close: () => void }> {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vos-106-probe-"));
  cpSync(FIXTURE, vaultRoot, { recursive: true });

  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS);

  // Seed agent_cards from fixture starter-vault agent.md frontmatter.
  // For simplicity, hardcode the three known agents with their scopes.
  const seeds = {
    maya: { name: "maya", read_scope: ["vault/**"], write_scope: [] },
    journaler: { name: "journaler", read_scope: ["vault/journal/**"], write_scope: ["vault/journal/**"] },
    "task-tracker": { name: "task-tracker", read_scope: ["vault/work/**", "vault/journal/**"], write_scope: ["vault/work/**"] },
  };
  for (const [name, card] of Object.entries(seeds)) {
    db.run("INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)", [name, JSON.stringify(card)]);
  }

  const bus = createEventBus({ db });
  const bridge = createAskUserBridge({ db, bus });
  const engine = createPermissionEngine({ vaultRoot, homeRoot: process.env.HOME ?? "" });
  const repo = makeChatRepo(db);

  const app = new Hono();

  // Spin up a real HTTP listener so CC subprocesses can reach /mcp.
  // app.request() (used by the harness itself for chat creation + polling)
  // continues to work alongside Bun.serve.
  // idleTimeout: 0 disables the per-request idle deadline so long MCP
  // SSE/stream connections from CC subprocesses are not killed mid-flight.
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 0 });
  const daemonBase = `http://127.0.0.1:${server.port}`;

  // Per-agent orchestrator (real claude-code provider).
  const orchByAgent = new Map<string, ReturnType<typeof makeOrchestrator>>();
  function orchFor(agent: string) {
    let o = orchByAgent.get(agent);
    if (o) return o;
    const provider = makeProvider(process.env as never, {
      bus, db, tracesDir: join(vaultRoot, ".traces"), agent, cwd: vaultRoot,
      engine, daemonBase, hookScriptPath: HOOK,
      loadAgentDefn: (n) => defaultLoadAgentDefn(db, n),
    });
    o = makeOrchestrator({ db, repo, provider, cwd: vaultRoot, emit: () => {}, titler: { title: async () => {} } });
    orchByAgent.set(agent, o);
    return o;
  }
  const routedOrch = {
    async dispatch(chatId: string, text: string) {
      const chat = repo.get(chatId);
      if (!chat) throw new Error(`chat not found: ${chatId}`);
      return orchFor(chat.agent).dispatch(chatId, text);
    },
    async cancel(chatId: string) {
      const chat = repo.get(chatId);
      if (!chat) return { cancelled: false, run_id: null };
      return orchFor(chat.agent).cancel(chatId);
    },
  };

  app.route("/", chatsApi(db));
  app.route("/", chatApi(db, { orchestrator: routedOrch }));
  const writer = createVaultWriter({ vaultRoot, db });
  mountMcp(app, { vaultRoot, db, bus, bridge, engine, writer });
  mountAnswerRoute(app, { db, bridge });

  return {
    app,
    vaultRoot,
    close: () => {
      server.stop();
      db.close();
    },
  };
}

async function runProbe(app: Hono, probe: Probe): Promise<{ pass: boolean; reply: string }> {
  const createRes = await app.request("/chats", {
    method: "POST",
    body: JSON.stringify({ agent: probe.agent }),
    headers: { "content-type": "application/json" },
  });
  const { id } = (await createRes.json()) as { id: string };

  const msgRes = await app.request(`/chat/${id}/message`, {
    method: "POST",
    body: JSON.stringify({ text: probe.prompt }),
    headers: { "content-type": "application/json" },
  });
  await msgRes.json();

  // Poll for terminal state, then fetch the reply.
  // session-replay shape: discriminated union of TextMessage ({role, content}),
  // ToolUseEntry ({role:"tool_use", name, input}), ToolResultEntry
  // ({role:"tool_result", output}). Some probes (e.g. journaler/log-session,
  // task-tracker/promote) yield a tool_use only with no terminal assistant
  // text. So we wait for the run to reach a terminal state via /chat/:id and
  // then build a flattened reply that includes assistant narration + the
  // JSON of tool_use blocks. This lets path/argument regexes match values
  // that appear in tool inputs as well as in spoken narration.
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const chatRes = await app.request(`/chat/${id}`);
    const chat = (await chatRes.json()) as { current_run_id?: string | null };
    const runIdle =
      chat &&
      (chat.current_run_id === null || chat.current_run_id === undefined);

    if (runIdle) {
      const r = await app.request(`/chat/${id}/messages`);
      const msgs = (await r.json()) as Array<{
        role: string;
        content?: string;
        name?: string;
        input?: unknown;
      }>;
      const parts: string[] = [];
      for (const m of msgs) {
        if (m.role === "assistant" && typeof m.content === "string") {
          parts.push(m.content);
        } else if (m.role === "tool_use") {
          parts.push(`tool_use:${m.name ?? ""} ${JSON.stringify(m.input ?? {})}`);
        }
      }
      // Require at least one assistant or tool_use entry so we don't
      // accept an empty pre-dispatch poll as terminal.
      if (parts.length > 0) {
        const reply = parts.join("\n");
        return { pass: probe.expectRegex.test(reply), reply };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { pass: false, reply: "<timeout>" };
}

async function main() {
  const { app, close } = await bootProbeDaemon();
  let strictPass = 0;
  const results: Array<{ probe: string; verdict: string; reply: string }> = [];
  for (const probe of PROBES) {
    try {
      const { pass, reply } = await runProbe(app, probe);
      const verdict = pass ? "PASS" : "FAIL";
      if (pass) strictPass++;
      results.push({ probe: probe.label, verdict, reply: reply.slice(0, 200) });
      console.log(`${verdict}  ${probe.label}\n  expected: ${probe.expectDesc}\n  reply: ${reply.slice(0, 200)}\n`);
    } catch (e) {
      results.push({ probe: probe.label, verdict: "PROBE_DESIGN_BUG", reply: String(e) });
      console.log(`PROBE_DESIGN_BUG  ${probe.label}: ${e}\n`);
    }
  }
  close();
  console.log(`\nSummary: ${strictPass}/${PROBES.length} strict pass`);
  if (strictPass < 5) {
    console.log("FAIL: <5/6 strict pass — acceptance gate not met.");
    process.exit(1);
  }
  console.log("PASS: ≥5/6 strict pass.");
}

await main();
