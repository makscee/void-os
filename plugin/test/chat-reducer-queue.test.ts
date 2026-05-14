// Per-chat send queue reducer tests.
//
// VOS-80 reframe: composer is always-on. When user sends while runState is
// "running", the runtime DOES NOT POST — instead it enqueues into the chat's
// local queue, renders a faded "↻ queued" bubble, and on `run.end` for any
// terminal status pops the queue head + POSTs.

import { describe, test, expect } from "bun:test";
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from "../src/chat/reducer";

const CHAT = "c1";
const seed = (): ChatState => initialChatState(CHAT);

describe("chatReducer queue", () => {
  test("enqueue while running pushes to per-chat queue", () => {
    let s = seed();
    s = chatReducer(s, { kind: "enqueue", chatId: CHAT, id: "q1", text: "hello" });
    expect(s.queues[CHAT]).toEqual([{ id: "q1", text: "hello" }]);
    s = chatReducer(s, { kind: "enqueue", chatId: CHAT, id: "q2", text: "world" });
    expect(s.queues[CHAT]).toEqual([
      { id: "q1", text: "hello" },
      { id: "q2", text: "world" },
    ]);
  });

  test("enqueue is idempotent on duplicate id (no double-add on rapid sends)", () => {
    let s = seed();
    s = chatReducer(s, { kind: "enqueue", chatId: CHAT, id: "q1", text: "hi" });
    s = chatReducer(s, { kind: "enqueue", chatId: CHAT, id: "q1", text: "hi" });
    expect(s.queues[CHAT]).toHaveLength(1);
  });

  test("dequeue removes by id; empty list clears the key", () => {
    let s = seed();
    s = chatReducer(s, { kind: "enqueue", chatId: CHAT, id: "q1", text: "a" });
    s = chatReducer(s, { kind: "enqueue", chatId: CHAT, id: "q2", text: "b" });
    s = chatReducer(s, { kind: "dequeue", chatId: CHAT, id: "q1" });
    expect(s.queues[CHAT]).toEqual([{ id: "q2", text: "b" }]);
    s = chatReducer(s, { kind: "dequeue", chatId: CHAT, id: "q2" });
    expect(s.queues[CHAT]).toBeUndefined();
  });

  test("per-chat isolation: enqueue chat A; switch to B; queue empty for B; switch back; intact for A", () => {
    let s = seed();
    s = chatReducer(s, { kind: "enqueue", chatId: CHAT, id: "qA", text: "from A" });
    s = chatReducer(s, { kind: "set_chat", chatId: "c2" });
    expect(s.chatId).toBe("c2");
    // Queue map persists across set_chat — but the c2 queue is empty.
    expect(s.queues["c2"]).toBeUndefined();
    // Switch back to c1 — A's queue is still there.
    s = chatReducer(s, { kind: "set_chat", chatId: CHAT });
    expect(s.queues[CHAT]).toEqual([{ id: "qA", text: "from A" }]);
  });

  test("set_chat resets messages + runState but preserves queues map", () => {
    let s = chatReducer(seed(), {
      kind: "enqueue",
      chatId: CHAT,
      id: "q1",
      text: "x",
    });
    s = chatReducer(s, {
      kind: "frame",
      frame: { type: "run.start", chat_id: CHAT, run_id: "r1", agent: "maya" },
    });
    s = chatReducer(s, { kind: "set_chat", chatId: "c2" });
    expect(s.messages).toEqual([]);
    expect(s.runState).toBe("idle");
    expect(s.queues[CHAT]).toEqual([{ id: "q1", text: "x" }]);
  });
});
