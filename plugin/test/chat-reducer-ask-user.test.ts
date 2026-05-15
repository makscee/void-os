import { describe, it, expect, spyOn } from "bun:test";
import { chatReducer, initialChatState } from "../src/chat/reducer";

const baseChat = "chat-1";

function withChat() {
  return chatReducer(initialChatState(baseChat), { kind: "set_chat", chatId: baseChat });
}

describe("reducer pendingAskUser", () => {
  it("starts null", () => {
    expect(withChat().pendingAskUser).toBeNull();
  });

  it("set by chat.tool_use with name==ask_user", () => {
    const s1 = chatReducer(withChat(), {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: baseChat,
        run_id: "r1",
        tool_call_id: "tu-1",
        name: "ask_user",
        input: { question: "color?", options: ["red", "blue"] },
      } as never,
    });
    expect(s1.pendingAskUser).toEqual({
      toolUseId: "tu-1",
      question: "color?",
      options: ["red", "blue"],
    });
  });

  it("ignores chat.tool_use with other names", () => {
    const s1 = chatReducer(withChat(), {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: baseChat,
        run_id: "r1",
        tool_call_id: "tu-1",
        name: "Bash",
        input: { command: "ls" },
      } as never,
    });
    expect(s1.pendingAskUser).toBeNull();
  });

  it("cleared by chat.tool_result with matching tool_call_id", () => {
    let s = chatReducer(withChat(), {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: baseChat,
        run_id: "r1",
        tool_call_id: "tu-1",
        name: "ask_user",
        input: { question: "q" },
      } as never,
    });
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.tool_result",
        chat_id: baseChat,
        run_id: "r1",
        tool_call_id: "tu-1",
        output: "red",
      } as never,
    });
    expect(s.pendingAskUser).toBeNull();
  });

  it("UNCHANGED by task.state_changed → WORKING (D7 race)", () => {
    let s = chatReducer(withChat(), {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: baseChat,
        run_id: "r1",
        tool_call_id: "tu-1",
        name: "ask_user",
        input: { question: "q" },
      } as never,
    });
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "task.state_changed",
        chat_id: baseChat,
        payload: { taskId: "t", state: "TASK_STATE_WORKING" },
      } as never,
    });
    expect(s.pendingAskUser).not.toBeNull();
  });

  it("cleared by set_chat", () => {
    const s1 = chatReducer(withChat(), {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: baseChat,
        run_id: "r1",
        tool_call_id: "tu-1",
        name: "ask_user",
        input: { question: "q" },
      } as never,
    });
    const s2 = chatReducer(s1, { kind: "set_chat", chatId: "other" });
    expect(s2.pendingAskUser).toBeNull();
  });

  it("refetched rehydrates from last unpaired ask_user tool_use", () => {
    const s = chatReducer(withChat(), {
      kind: "refetched",
      chatId: baseChat,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "" },
        { role: "tool_use", tool_call_id: "tu-1", name: "ask_user", input: { question: "color?", options: ["red"] } },
      ],
    });
    expect(s.pendingAskUser).toEqual({
      toolUseId: "tu-1",
      question: "color?",
      options: ["red"],
    });
  });

  it("refetched clears when ask_user is paired with tool_result", () => {
    const s = chatReducer(withChat(), {
      kind: "refetched",
      chatId: baseChat,
      messages: [
        { role: "tool_use", tool_call_id: "tu-1", name: "ask_user", input: { question: "q" } },
        { role: "tool_result", tool_call_id: "tu-1", output: "red" },
      ],
    });
    expect(s.pendingAskUser).toBeNull();
  });

  it("refetched picks latest when two unpaired ask_user rows + console.warn fires", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const s = chatReducer(withChat(), {
      kind: "refetched",
      chatId: baseChat,
      messages: [
        { role: "tool_use", tool_call_id: "tu-1", name: "ask_user", input: { question: "first?" } },
        { role: "tool_use", tool_call_id: "tu-2", name: "ask_user", input: { question: "second?" } },
      ],
    });
    expect(s.pendingAskUser?.toolUseId).toBe("tu-2");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("local_answer_409 clears pendingAskUser", () => {
    let s = chatReducer(withChat(), {
      kind: "frame",
      frame: {
        type: "chat.tool_use",
        chat_id: baseChat,
        run_id: "r1",
        tool_call_id: "tu-1",
        name: "ask_user",
        input: { question: "q" },
      } as never,
    });
    s = chatReducer(s, { kind: "local_answer_409" });
    expect(s.pendingAskUser).toBeNull();
  });
});
