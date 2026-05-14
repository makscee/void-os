// VOS-80 part 2 — tool frame contract.
//
// Tool events from WS frames flow into the liveToolEvents overlay buffer.
// They do NOT mutate state.messages. The canonical post-run representation
// (with tool_use/tool_result entries attached to the surrounding assistant
// turn) is produced by replayToMessages when refetched/hydrate dispatches
// the daemon's GET /chat/:id/messages response.

import { describe, test, expect } from "bun:test";
import {
  chatReducer,
  initialChatState,
  type ChatState,
  type ToolPart,
} from "../src/chat/reducer";
import type { DaemonFrame } from "../src/chat/bus";

const CHAT = "c1";
const RUN = "r1";

const seed = (): ChatState => initialChatState(CHAT);
const frame = (f: DaemonFrame) => ({ kind: "frame" as const, frame: f });

function findTool(state: ChatState, toolCallId: string): ToolPart | undefined {
  return state.liveToolEvents.find((p) => p.toolCallId === toolCallId);
}

describe("chatReducer tool events (VOS-80 part 2 — live overlay)", () => {
  test("tool_use appends a ToolPart to liveToolEvents; messages untouched", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "running cmd " }));
    s = chatReducer(s, frame({
      type: "chat.tool_use",
      chat_id: CHAT,
      run_id: RUN,
      tool_call_id: "tu_1",
      name: "Bash",
      input: { command: "ls" },
    }));
    expect(s.liveTokens).toBe("running cmd ");
    const t = findTool(s, "tu_1");
    expect(t).toBeTruthy();
    expect(t!.name).toBe("Bash");
    expect(t!.input).toEqual({ command: "ls" });
    expect(t!.output).toBeUndefined();
    expect(t!.isError).toBe(false);
    // messages stays empty — canonical state comes via refetch.
    expect(s.messages.length).toBe(0);
  });

  test("tool_result pairs by tool_call_id and merges string output in overlay", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "chat.tool_use",
      chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      name: "Bash", input: { command: "echo hi" },
    }));
    s = chatReducer(s, frame({
      type: "chat.tool_result",
      chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      output: "hi\n", is_error: false,
    }));
    const t = findTool(s, "tu_1");
    expect(t!.output).toBe("hi\n");
    expect(t!.isError).toBe(false);
  });

  test("tool_result normalizes block-array output to string", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "chat.tool_use", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      name: "Edit", input: { path: "f.ts" },
    }));
    s = chatReducer(s, frame({
      type: "chat.tool_result", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      output: [{ type: "text", text: "ok line 1\n" }, { type: "text", text: "ok line 2" }],
      is_error: false,
    }));
    const t = findTool(s, "tu_1");
    expect(t!.output).toBe("ok line 1\nok line 2");
  });

  test("tool_result with is_error=true sets isError flag in overlay", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "chat.tool_use", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      name: "Bash", input: { command: "false" },
    }));
    s = chatReducer(s, frame({
      type: "chat.tool_result", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      output: "boom", is_error: true,
    }));
    const t = findTool(s, "tu_1");
    expect(t!.isError).toBe(true);
    expect(t!.output).toBe("boom");
  });

  test("tool_result without prior tool_use creates a synthetic pending entry (defensive)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "chat.tool_result", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_orphan",
      output: "stray", is_error: false,
    }));
    const t = findTool(s, "tu_orphan");
    expect(t).toBeTruthy();
    expect(t!.output).toBe("stray");
    expect(t!.name).toBe("");
    expect(t!.input).toEqual({});
  });

  test("tool frames for a different chat_id are dropped", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    const before = s;
    const after = chatReducer(before, frame({
      type: "chat.tool_use", chat_id: "other", run_id: RUN, tool_call_id: "x",
      name: "Bash", input: { command: "ls" },
    }));
    expect(after).toBe(before);
  });

  test("run.end clears liveToolEvents (overlay disarmed; refetch will rehydrate)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "chat.tool_use", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      name: "Bash", input: { command: "ls" },
    }));
    expect(s.liveToolEvents.length).toBe(1);
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" }));
    expect(s.liveToolEvents).toEqual([]);
  });

  test("hydrate/refetched mixed text + tool entries attaches tools to preceding assistant message", () => {
    let s = seed();
    s = chatReducer(s, {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        { role: "user", content: "run ls" },
        { role: "assistant", content: "ok" },
        { role: "tool_use", tool_call_id: "tu_h1", name: "Bash", input: { command: "ls" } },
        { role: "tool_result", tool_call_id: "tu_h1", output: "a\nb\n", is_error: false },
        { role: "assistant", content: "done" },
      ],
    });
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant"]);
    const a1 = s.messages[1];
    const tParts = (a1.parts ?? []).filter((p) => p.kind === "tool") as ToolPart[];
    expect(tParts.length).toBe(1);
    expect(tParts[0].toolCallId).toBe("tu_h1");
    expect(tParts[0].output).toBe("a\nb\n");
    expect(tParts[0].name).toBe("Bash");
  });

  test("refetched with tool entry before any assistant turn surfaces a synthetic carrier", () => {
    let s = seed();
    s = chatReducer(s, {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        { role: "tool_use", tool_call_id: "tu_orphan", name: "Bash", input: {} },
        { role: "tool_result", tool_call_id: "tu_orphan", output: "x", is_error: false },
      ],
    });
    expect(s.messages.length).toBe(1);
    expect(s.messages[0].role).toBe("assistant");
    const t = (s.messages[0].parts ?? []).find((p) => p.kind === "tool") as ToolPart | undefined;
    expect(t).toBeTruthy();
    expect(t!.output).toBe("x");
  });
});
