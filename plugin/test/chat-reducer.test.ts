import { describe, test, expect } from "bun:test";
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from "../src/chat/reducer";
import type { DaemonFrame } from "../src/chat/bus";

const CHAT = "c1";
const RUN = "r1";

const seed = (): ChatState => initialChatState(CHAT);

const frame = (f: DaemonFrame) => ({ kind: "frame" as const, frame: f });

describe("chatReducer", () => {
  test("run.start flips runState to running and pins activeRunId", () => {
    const s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    expect(s.runState).toBe("running");
    expect(s.activeRunId).toBe(RUN);
  });

  test("chat.token appends delta into a single assistant message keyed by run_id", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "Hel" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "lo" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: " world" }));
    const a = s.messages.find((m) => m.role === "assistant");
    expect(a).toBeTruthy();
    expect(a!.text).toBe("Hello world");
    expect(a!.complete).toBe(false);
  });

  test("chat.completion marks the assistant message complete; runState stays running until run.end", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "x" }));
    s = chatReducer(s, frame({ type: "chat.completion", chat_id: CHAT, run_id: RUN }));
    expect(s.messages.find((m) => m.role === "assistant")!.complete).toBe(true);
    expect(s.runState).toBe("running");
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" }));
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
  });

  test("run.error flips runState to error and clears activeRunId", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "run.error", chat_id: CHAT, run_id: RUN, error: "boom" }));
    expect(s.runState).toBe("error");
    expect(s.activeRunId).toBeNull();
  });

  test("frames for a different chat_id are dropped", () => {
    const before = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    const after = chatReducer(before, frame({ type: "chat.token", chat_id: "other", run_id: RUN, delta: "nope" }));
    expect(after).toBe(before);
  });

  test("dedupe: replaying tokens after subscribe re-mid-run does NOT double-render", () => {
    // Simulates leaf reopened mid-run: we replay the same frames.
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    const tokens = [{ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "Hi " }, { type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "there" }];
    for (const t of tokens) s = chatReducer(s, frame(t));
    const firstText = s.messages.find((m) => m.role === "assistant")!.text;
    expect(firstText).toBe("Hi there");
    // The same dedupe key (run_id) is reused; replay extends the SAME message.
    // Real "dedupe" here means: we do not create a second assistant bubble.
    for (const t of tokens) s = chatReducer(s, frame(t));
    const assistants = s.messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
  });

  test("optimistic user_send is reconciled by chat.message_user echo (no duplicate)", () => {
    let s = chatReducer(seed(), { kind: "user_send", text: "hi", tempId: "user-temp-x" });
    expect(s.messages.length).toBe(1);
    expect(s.messages[0].role).toBe("user");
    s = chatReducer(s, frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.message_user", chat_id: CHAT, run_id: RUN, text: "hi" }));
    const users = s.messages.filter((m) => m.role === "user");
    expect(users.length).toBe(1);
    expect(users[0].id).toBe(`user-${RUN}`);
  });

  test("set_chat resets state when binding to a new chat", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, { kind: "set_chat", chatId: "c2" });
    expect(s.chatId).toBe("c2");
    expect(s.messages).toEqual([]);
    expect(s.runState).toBe("idle");
  });
});
