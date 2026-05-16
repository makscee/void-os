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

describe("chatReducer — chat.task.state_changed", () => {
  function stateWithChild() {
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
    return s;
  }

  it("maps daemon states to ChildTaskStream.state", () => {
    const cases: Array<[string, string]> = [
      ["SUBMITTED",        "WORKING"],
      ["WORKING",          "WORKING"],
      ["WAITING_ON_AGENT", "WORKING"],
      ["INPUT_REQUIRED",   "INPUT_REQUIRED"],
      ["COMPLETED",        "COMPLETED"],
      ["FAILED",           "FAILED"],
      ["CANCELED",         "CANCELED"],
    ];
    let s = stateWithChild();
    for (const [wireState, uiState] of cases) {
      s = chatReducer(s, {
        kind: "frame",
        frame: {
          type: "chat.task.state_changed",
          chat_id: "ctx-1",
          task_id: "t-child",
          parent_task_id: "t-parent",
          state: wireState as "SUBMITTED" | "WORKING" | "WAITING_ON_AGENT" | "INPUT_REQUIRED" | "COMPLETED" | "FAILED" | "CANCELED",
        },
      });
      expect(s.childTasks["t-child"].state).toBe(uiState);
    }
  });

  it("FAILED captures error string", () => {
    let s = stateWithChild();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.task.state_changed",
        chat_id: "ctx-1",
        task_id: "t-child",
        parent_task_id: "t-parent",
        state: "FAILED",
        error: "fake: provider auth fail",
      },
    });
    expect(s.childTasks["t-child"].state).toBe("FAILED");
    expect(s.childTasks["t-child"].error).toBe("fake: provider auth fail");
  });

  it("sets error to null when no error field present", () => {
    let s = stateWithChild();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.task.state_changed",
        chat_id: "ctx-1",
        task_id: "t-child",
        parent_task_id: "t-parent",
        state: "COMPLETED",
      },
    });
    expect(s.childTasks["t-child"].error).toBeNull();
  });

  it("unknown task_id is a no-op (same state reference)", () => {
    const s = stateWithChild();
    const after = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.task.state_changed",
        chat_id: "ctx-1",
        task_id: "t-unknown",
        parent_task_id: null,
        state: "COMPLETED",
      },
    });
    expect(after).toBe(s);
  });
});

// ── Helper: state with a running parent and one child task ────────────────────
function stateWithChildAndRun() {
  // Start with a state that has an active parent run + child task
  let s = initialChatState("ctx-1");
  // arm the parent overlay
  s = chatReducer(s, {
    kind: "frame",
    frame: { type: "run.start", chat_id: "ctx-1", run_id: "run-p1", agent: "parent" },
  });
  // register the child task
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
  return s;
}

describe("chatReducer — chat.token child routing (T14)", () => {
  it("chat.token with task_id in childTasks lands in childTasks[tid].liveTokens", () => {
    let s = stateWithChildAndRun();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.token",
        chat_id: "ctx-1",
        run_id: "run-p1",
        task_id: "t-child",
        delta: "hello ",
      },
    });
    expect(s.childTasks["t-child"].liveTokens).toBe("hello ");
    expect(s.liveTokens).toBe("");
  });

  it("chat.token with task_id accumulates correctly on subsequent deltas", () => {
    let s = stateWithChildAndRun();
    s = chatReducer(s, {
      kind: "frame",
      frame: { type: "chat.token", chat_id: "ctx-1", run_id: "run-p1", task_id: "t-child", delta: "foo" },
    });
    s = chatReducer(s, {
      kind: "frame",
      frame: { type: "chat.token", chat_id: "ctx-1", run_id: "run-p1", task_id: "t-child", delta: "bar" },
    });
    expect(s.childTasks["t-child"].liveTokens).toBe("foobar");
    expect(s.liveTokens).toBe("");
  });

  it("parent chat.token (no task_id) lands in parent.liveTokens, childTasks untouched", () => {
    let s = stateWithChildAndRun();
    s = chatReducer(s, {
      kind: "frame",
      frame: { type: "chat.token", chat_id: "ctx-1", run_id: "run-p1", delta: "parent token" },
    });
    expect(s.liveTokens).toBe("parent token");
    expect(s.childTasks["t-child"].liveTokens).toBe("");
  });

  it("chat.token with unknown task_id falls through to parent path", () => {
    let s = stateWithChildAndRun();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.token",
        chat_id: "ctx-1",
        run_id: "run-p1",
        task_id: "t-unknown",
        delta: "spill",
      },
    });
    // unknown task_id → treated as parent delta
    expect(s.liveTokens).toBe("spill");
    expect(s.childTasks["t-child"].liveTokens).toBe("");
  });
});

describe("chatReducer — chat.tool_use child routing (T14)", () => {
  it("chat.tool_use with child task_id appends to childTasks liveToolEvents, not parent", () => {
    let s = stateWithChildAndRun();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: "ctx-1",
        run_id: "run-p1",
        task_id: "t-child",
        tool_call_id: "tc-child-1",
        name: "read_file",
        input: { path: "/tmp/x" },
      },
    });
    expect(s.childTasks["t-child"].liveToolEvents).toHaveLength(1);
    expect(s.childTasks["t-child"].liveToolEvents[0]).toMatchObject({
      kind: "tool",
      toolCallId: "tc-child-1",
      name: "read_file",
      input: { path: "/tmp/x" },
      isError: false,
    });
    expect(s.liveToolEvents).toHaveLength(0);
  });

  it("duplicate chat.tool_use (same tool_call_id) for child is idempotent", () => {
    let s = stateWithChildAndRun();
    const frame = {
      type: "chat.tool_use" as const,
      chat_id: "ctx-1",
      run_id: "run-p1",
      task_id: "t-child",
      tool_call_id: "tc-child-1",
      name: "read_file",
      input: { path: "/tmp/x" },
    };
    s = chatReducer(s, { kind: "frame", frame });
    const before = s;
    s = chatReducer(s, { kind: "frame", frame });
    expect(s).toBe(before);
  });

  it("parent chat.tool_use (no task_id) goes to parent liveToolEvents", () => {
    let s = stateWithChildAndRun();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: "ctx-1",
        run_id: "run-p1",
        tool_call_id: "tc-parent-1",
        name: "bash",
        input: { cmd: "echo hi" },
      },
    });
    expect(s.liveToolEvents).toHaveLength(1);
    expect(s.childTasks["t-child"].liveToolEvents).toHaveLength(0);
  });
});

describe("chatReducer — chat.tool_result child routing (T14)", () => {
  function stateWithChildToolUse() {
    let s = stateWithChildAndRun();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: "ctx-1",
        run_id: "run-p1",
        task_id: "t-child",
        tool_call_id: "tc-child-1",
        name: "read_file",
        input: { path: "/tmp/x" },
      },
    });
    return s;
  }

  it("chat.tool_result with child task_id matching prior tool_use updates that part's output", () => {
    let s = stateWithChildToolUse();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_result",
        chat_id: "ctx-1",
        run_id: "run-p1",
        task_id: "t-child",
        tool_call_id: "tc-child-1",
        output: "file contents here",
        is_error: false,
      },
    });
    const part = s.childTasks["t-child"].liveToolEvents[0];
    expect(part.output).toBe("file contents here");
    expect(part.isError).toBe(false);
    expect(s.liveToolEvents).toHaveLength(0);
  });

  it("chat.tool_result with is_error=true sets isError on child part", () => {
    let s = stateWithChildToolUse();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_result",
        chat_id: "ctx-1",
        run_id: "run-p1",
        task_id: "t-child",
        tool_call_id: "tc-child-1",
        output: "something broke",
        is_error: true,
      },
    });
    expect(s.childTasks["t-child"].liveToolEvents[0].isError).toBe(true);
  });

  it("chat.tool_result for unknown tool_call_id appends stub to child liveToolEvents", () => {
    let s = stateWithChildAndRun();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_result",
        chat_id: "ctx-1",
        run_id: "run-p1",
        task_id: "t-child",
        tool_call_id: "tc-orphan",
        output: "orphan result",
        is_error: false,
      },
    });
    expect(s.childTasks["t-child"].liveToolEvents).toHaveLength(1);
    expect(s.childTasks["t-child"].liveToolEvents[0]).toMatchObject({
      kind: "tool",
      toolCallId: "tc-orphan",
      output: "orphan result",
      isError: false,
    });
    expect(s.liveToolEvents).toHaveLength(0);
  });

  it("parent chat.tool_result (no task_id) goes to parent liveToolEvents", () => {
    let s = stateWithChildAndRun();
    // add a parent tool_use first
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: "ctx-1",
        run_id: "run-p1",
        tool_call_id: "tc-parent-1",
        name: "bash",
        input: {},
      },
    });
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_result",
        chat_id: "ctx-1",
        run_id: "run-p1",
        tool_call_id: "tc-parent-1",
        output: "done",
        is_error: false,
      },
    });
    expect(s.liveToolEvents[0].output).toBe("done");
    expect(s.childTasks["t-child"].liveToolEvents).toHaveLength(0);
  });
});

describe("chatReducer — refetched rebuilds childTasks (T15)", () => {
  it("refetched rebuilds childTasks from synthetic child_task_started entries", () => {
    let s = initialChatState("ctx-1");
    const replay: any[] = [
      { role: "user", content: "go", ts: 1, task_id: "t-parent" },
      { role: "assistant", content: "calling journaler", ts: 2, task_id: "t-parent" },
      { role: "tool_use", tool_call_id: "tc-1", name: "ask_agent", input: {}, ts: 2, task_id: "t-parent" },
      { role: "child_task_started", chat_id: "ctx-1", parent_task_id: "t-parent",
        parent_tool_call_id: "tc-1", child_task_id: "t-child", agent: "journaler",
        task_state: "COMPLETED", ts: 2, task_id: "t-child" },
      { role: "assistant", content: "A", ts: 3, task_id: "t-child" },
      { role: "tool_result", tool_call_id: "tc-1", output: "A", is_error: false, ts: 4, task_id: "t-parent" },
    ];
    s = chatReducer(s, { kind: "refetched", chatId: "ctx-1", messages: replay as any });

    expect(s.childTasks["t-child"]).toMatchObject({
      taskId: "t-child", agent: "journaler", state: "COMPLETED",
      parentTaskId: "t-parent", parentToolCallId: "tc-1",
    });
    expect(s.childTasks["t-child"].messages.map((m: any) => m.text)).toEqual(["A"]);
    expect(s.toolCallToChild["tc-1"]).toBe("t-child");
    // Parent thread does not contain the child's assistant message.
    expect(s.messages.find((m: any) => m.text === "A")).toBeUndefined();
  });

  it("refetched preserves manualToggle for existing taskIds", () => {
    let s = initialChatState("ctx-1");
    s = chatReducer(s, { kind: "frame", frame: { type: "chat.child_task_started",
      chat_id: "ctx-1", parent_task_id: "t-parent", parent_tool_call_id: "tc-1",
      child_task_id: "t-child", agent: "journaler" } as any });
    s = {
      ...s,
      childTasks: {
        ...s.childTasks,
        "t-child": { ...s.childTasks["t-child"], manualToggle: "collapsed" },
      },
    };
    const replay: any[] = [
      { role: "child_task_started", chat_id: "ctx-1", parent_task_id: "t-parent",
        parent_tool_call_id: "tc-1", child_task_id: "t-child", agent: "journaler",
        task_state: "COMPLETED", ts: 1, task_id: "t-child" },
      { role: "assistant", content: "A", ts: 2, task_id: "t-child" },
    ];
    s = chatReducer(s, { kind: "refetched", chatId: "ctx-1", messages: replay as any });
    expect(s.childTasks["t-child"].manualToggle).toBe("collapsed");
  });
});
