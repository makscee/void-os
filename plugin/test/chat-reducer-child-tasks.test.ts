// VOS-91 T11 — ChildTaskStream types + ChatState.childTasks / toolCallToChild
// shape contract for initialChatState.
// VOS-91 T12 — chatReducer handles chat.child_task_started frame.

import { describe, test, it, expect } from "bun:test";
import {
  initialChatState,
  chatReducer,
  TERMINAL_CHILD_STATES,
} from "../src/chat/reducer";

describe("initialChatState child-task fields", () => {
  test("childTasks starts as empty record", () => {
    const s = initialChatState("chat-1");
    expect(s.childTasks).toEqual({});
  });

  test("toolCallToChild starts as empty record", () => {
    const s = initialChatState("chat-1");
    expect(s.toolCallToChild).toEqual({});
  });

  test("initialChatState with null chatId also has empty child maps", () => {
    const s = initialChatState();
    expect(s.childTasks).toEqual({});
    expect(s.toolCallToChild).toEqual({});
  });
});

describe("TERMINAL_CHILD_STATES", () => {
  test("COMPLETED is terminal", () => {
    expect(TERMINAL_CHILD_STATES.has("COMPLETED")).toBe(true);
  });

  test("FAILED is terminal", () => {
    expect(TERMINAL_CHILD_STATES.has("FAILED")).toBe(true);
  });

  test("CANCELED is terminal", () => {
    expect(TERMINAL_CHILD_STATES.has("CANCELED")).toBe(true);
  });

  test("WORKING is not terminal", () => {
    expect(TERMINAL_CHILD_STATES.has("WORKING")).toBe(false);
  });

  test("INPUT_REQUIRED is not terminal", () => {
    expect(TERMINAL_CHILD_STATES.has("INPUT_REQUIRED")).toBe(false);
  });
});

describe("chatReducer — chat.child_task_started", () => {
  it("seeds ChildTaskStream WORKING + binds toolCallToChild", () => {
    let s = initialChatState("ctx-1");
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.child_task_started",
        chat_id: "ctx-1",
        parent_task_id: "t-parent",
        parent_tool_call_id: "tc-1",
        child_task_id: "t-child",
        agent: "journaler",
      },
    });
    expect(s.childTasks["t-child"]).toMatchObject({
      taskId: "t-child",
      runId: "child-t-child",
      parentToolCallId: "tc-1",
      parentTaskId: "t-parent",
      agent: "journaler",
      state: "WORKING",
      error: null,
      liveTokens: "",
      liveToolEvents: [],
      messages: [],
      manualToggle: "auto",
    });
    expect(s.toolCallToChild["tc-1"]).toBe("t-child");
  });

  it("re-emitting chat.child_task_started returns same state reference", () => {
    let s = initialChatState("ctx-1");
    const frame = {
      type: "chat.child_task_started" as const,
      chat_id: "ctx-1",
      parent_task_id: "t-parent",
      parent_tool_call_id: "tc-1",
      child_task_id: "t-child",
      agent: "journaler",
    };
    s = chatReducer(s, { kind: "frame", frame });
    const before = s;
    s = chatReducer(s, { kind: "frame", frame });
    expect(s).toBe(before);
  });
});
