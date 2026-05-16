import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { makeSessionReplay } from "../../src/chat/session-replay";
import { makeMessagesRepo } from "../../src/chat/messages-repo";
import * as path from "node:path";

const MIG = path.resolve(__dirname, "../../src/adapters/sqlite/migrations");

describe("session-replay synthetic child_task_started", () => {
  it("splices a child_task_started entry before child's first message", () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIG);
    const now = Date.now();

    db.run(
      `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at) VALUES (?, ?, 0, ?, ?)`,
      ["ctx", "maya", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, parent_task_id, parent_tool_call_id, state, cost_usd, tokens_in, tokens_out, metadata, target_agent, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'TASK_STATE_COMPLETED', 0, 0, 0, '{}', NULL, ?, ?)`,
      ["t-parent", "ctx", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, parent_task_id, parent_tool_call_id, state, cost_usd, tokens_in, tokens_out, metadata, target_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'TASK_STATE_COMPLETED', 0, 0, 0, '{}', ?, ?, ?)`,
      ["t-child", "ctx", "t-parent", "tc-1", "journaler", now + 1, now + 1],
    );

    const m = makeMessagesRepo(db);
    m.appendMessage("t-parent", "ctx", null, "ROLE_USER", [{ text: "go" }], now);
    m.appendMessage(
      "t-parent",
      "ctx",
      null,
      "ROLE_AGENT",
      [
        { text: "calling journaler" },
        {
          data: {
            kind: "tool_use",
            tool_call_id: "tc-1",
            tool_name: "ask_agent",
            input: {},
          },
        },
      ],
      now + 1,
    );
    m.appendMessage(
      "t-child",
      "ctx",
      null,
      "ROLE_AGENT",
      [{ text: "A" }],
      now + 2,
    );
    m.appendMessage(
      "t-parent",
      "ctx",
      null,
      "ROLE_AGENT",
      [
        {
          data: {
            kind: "tool_result",
            tool_call_id: "tc-1",
            output: "A",
            is_error: false,
          },
        },
      ],
      now + 3,
    );

    const replay = makeSessionReplay(db);
    const out = replay.walk("ctx");

    const idxStarted = out.findIndex(
      (e: any) => e.role === "child_task_started" && e.child_task_id === "t-child",
    );
    const idxChildMsg = out.findIndex(
      (e: any) => e.task_id === "t-child" && e.role === "assistant",
    );

    expect(idxStarted).toBeGreaterThanOrEqual(0);
    expect(idxStarted).toBeLessThan(idxChildMsg);
    expect(out[idxStarted] as any).toMatchObject({
      parent_task_id: "t-parent",
      parent_tool_call_id: "tc-1",
      child_task_id: "t-child",
      agent: "journaler",
      task_state: "COMPLETED",
    });
  });

  it("orders sibling children by parent tool_use part_index, not child id alphabetical", () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIG);
    const now = Date.now();

    db.run(
      `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at) VALUES (?, ?, 0, ?, ?)`,
      ["ctx", "maya", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, parent_task_id, parent_tool_call_id, state, cost_usd, tokens_in, tokens_out, metadata, target_agent, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'TASK_STATE_COMPLETED', 0, 0, 0, '{}', NULL, ?, ?)`,
      ["t-parent", "ctx", now, now],
    );
    // Two child rows minted at the SAME ms — alpha order would put "t-a" first.
    db.run(
      `INSERT INTO tasks (id, context_id, parent_task_id, parent_tool_call_id, state, cost_usd, tokens_in, tokens_out, metadata, target_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'TASK_STATE_COMPLETED', 0, 0, 0, '{}', ?, ?, ?)`,
      ["t-z", "ctx", "t-parent", "tc-1", "journaler", now + 1, now + 1],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, parent_task_id, parent_tool_call_id, state, cost_usd, tokens_in, tokens_out, metadata, target_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'TASK_STATE_COMPLETED', 0, 0, 0, '{}', ?, ?, ?)`,
      ["t-a", "ctx", "t-parent", "tc-2", "archivist", now + 1, now + 1],
    );

    const m = makeMessagesRepo(db);
    // Parent message emits tool_use parts in the order tc-1 then tc-2.
    m.appendMessage(
      "t-parent",
      "ctx",
      null,
      "ROLE_AGENT",
      [
        {
          data: {
            kind: "tool_use",
            tool_call_id: "tc-1",
            tool_name: "ask_agent",
            input: {},
          },
        },
        {
          data: {
            kind: "tool_use",
            tool_call_id: "tc-2",
            tool_name: "ask_agent",
            input: {},
          },
        },
      ],
      now + 1,
    );

    const replay = makeSessionReplay(db);
    const out = replay.walk("ctx");

    const started = out.filter((e: any) => e.role === "child_task_started");
    // Must follow tool_use order (tc-1 → t-z, tc-2 → t-a), NOT alphabetical.
    expect(started.map((e: any) => e.child_task_id)).toEqual(["t-z", "t-a"]);
  });
});
