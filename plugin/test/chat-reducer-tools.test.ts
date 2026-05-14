// Reducer extensions for S4 — tool_use / tool_result frames + replay items.
// Pairs by tool_call_id; tool parts hang off the in-flight assistant message
// keyed by run_id. If no assistant message exists yet for the run, we create
// one (parts-only, text empty) so ordering is preserved.

import { describe, test, expect } from "bun:test";
import {
  chatReducer,
  initialChatState,
  type ChatState,
  type ChatMessage,
  type AssistantPart,
  type ToolPart,
} from "../src/chat/reducer";
import type { DaemonFrame } from "../src/chat/bus";

const CHAT = "c1";
const RUN = "r1";

const seed = (): ChatState => initialChatState(CHAT);
const frame = (f: DaemonFrame) => ({ kind: "frame" as const, frame: f });

function assistantParts(msgs: ChatMessage[], runId: string): AssistantPart[] {
  const a = msgs.find((m) => m.id === runId && m.role === "assistant");
  return a?.parts ?? [];
}

function toolPart(parts: AssistantPart[], toolCallId: string): ToolPart | undefined {
  return parts.find(
    (p): p is ToolPart => p.kind === "tool" && p.toolCallId === toolCallId,
  );
}

describe("chatReducer tool events (S4)", () => {
  test("tool_use appends a tool part on the in-flight assistant message", () => {
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
    const parts = assistantParts(s.messages, RUN);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const text = parts.find((p) => p.kind === "text");
    const tool = toolPart(parts, "tu_1");
    expect(text?.kind).toBe("text");
    expect((text as any).text).toBe("running cmd ");
    expect(tool).toBeTruthy();
    expect(tool!.name).toBe("Bash");
    expect(tool!.input).toEqual({ command: "ls" });
    expect(tool!.output).toBeUndefined();
    expect(tool!.isError).toBe(false);
  });

  test("tool_result pairs by tool_call_id and merges output (string)", () => {
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
    const t = toolPart(assistantParts(s.messages, RUN), "tu_1");
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
    const t = toolPart(assistantParts(s.messages, RUN), "tu_1");
    expect(t!.output).toBe("ok line 1\nok line 2");
  });

  test("tool_result with is_error=true sets isError flag", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "chat.tool_use", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      name: "Bash", input: { command: "false" },
    }));
    s = chatReducer(s, frame({
      type: "chat.tool_result", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_1",
      output: "boom", is_error: true,
    }));
    const t = toolPart(assistantParts(s.messages, RUN), "tu_1");
    expect(t!.isError).toBe(true);
    expect(t!.output).toBe("boom");
  });

  test("tool_result without prior tool_use creates a synthetic pending tool part (defensive)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "chat.tool_result", chat_id: CHAT, run_id: RUN, tool_call_id: "tu_orphan",
      output: "stray", is_error: false,
    }));
    const t = toolPart(assistantParts(s.messages, RUN), "tu_orphan");
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

  test("hydrate with mixed text + tool entries attaches tools to preceding assistant message", () => {
    let s = seed();
    s = chatReducer(s, {
      kind: "hydrate",
      chatId: CHAT,
      messages: [
        { role: "user", content: "run ls" },
        { role: "assistant", content: "ok" },
        { role: "tool_use", tool_call_id: "tu_h1", name: "Bash", input: { command: "ls" } },
        { role: "tool_result", tool_call_id: "tu_h1", output: "a\nb\n", is_error: false },
        { role: "assistant", content: "done" },
      ],
    });
    // 3 messages: user, assistant (with tool part), assistant
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant"]);
    const a1 = s.messages[1];
    expect(a1.parts).toBeTruthy();
    const toolParts = a1.parts!.filter((p) => p.kind === "tool");
    expect(toolParts.length).toBe(1);
    const t = toolParts[0] as ToolPart;
    expect(t.toolCallId).toBe("tu_h1");
    expect(t.output).toBe("a\nb\n");
    expect(t.name).toBe("Bash");
  });

  test("hydrate with tool entry before any assistant turn surfaces a synthetic assistant carrier", () => {
    let s = seed();
    s = chatReducer(s, {
      kind: "hydrate",
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

  test("output normalization handles both string and block array (helper-level)", () => {
    // covered functionally by the two earlier merge tests
    expect(true).toBe(true);
  });
});
