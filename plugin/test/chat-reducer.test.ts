// VOS-80 part 2 — reducer base contract.
//
// Daemon DB is canonical. WS frames feed the live overlay (liveTokens +
// liveToolEvents) and signal runState transitions. The reducer never
// mutates `state.messages` from chat.token / chat.tool_* frames — those
// flow into the overlay only. `state.messages` is replaced wholesale by
// the `refetched` (and legacy `hydrate`) action.

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
  test("run.start flips runState running + pins activeRunId + clears any stale overlay", () => {
    const s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    expect(s.runState).toBe("running");
    expect(s.activeRunId).toBe(RUN);
    expect(s.liveTokens).toBe("");
    expect(s.liveToolEvents).toEqual([]);
  });

  test("chat.token deltas accumulate in liveTokens; messages array stays untouched", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "Hel" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "lo" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: " world" }));
    expect(s.liveTokens).toBe("Hello world");
    // Critical invariant: messages is NOT mutated by token frames.
    expect(s.messages.length).toBe(0);
  });

  test("chat.completion is a no-op; only run.end terminates the overlay", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "x" }));
    const before = s;
    s = chatReducer(s, frame({ type: "chat.completion", chat_id: CHAT, run_id: RUN }));
    expect(s).toBe(before);
    expect(s.runState).toBe("running");
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" }));
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
    expect(s.liveTokens).toBe("");
  });

  test("run.error flips runState error + clears overlay", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "x" }));
    s = chatReducer(s, frame({ type: "run.error", chat_id: CHAT, run_id: RUN, error: "boom" }));
    expect(s.runState).toBe("error");
    expect(s.activeRunId).toBeNull();
    expect(s.liveTokens).toBe("");
  });

  test("frames for a different chat_id are dropped", () => {
    const before = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    const after = chatReducer(before, frame({ type: "chat.token", chat_id: "other", run_id: RUN, delta: "nope" }));
    expect(after).toBe(before);
  });

  test("replaying same token frames mid-run extends liveTokens (no separate bubble)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    const tokens = [
      { type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "Hi " },
      { type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "there" },
    ] as const;
    for (const t of tokens) s = chatReducer(s, frame(t));
    expect(s.liveTokens).toBe("Hi there");
    // No message bubble created from tokens — that comes via refetch.
    expect(s.messages.length).toBe(0);
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

  test("set_chat resets state + clears overlay when binding to a new chat", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "x" }));
    s = chatReducer(s, { kind: "set_chat", chatId: "c2" });
    expect(s.chatId).toBe("c2");
    expect(s.messages).toEqual([]);
    expect(s.liveTokens).toBe("");
    expect(s.runState).toBe("idle");
  });

  test("refetched replaces messages with replay rows (synthetic ids, complete=true)", () => {
    let s = seed();
    s = chatReducer(s, {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello!" },
      ],
    });
    expect(s.messages.length).toBe(2);
    expect(s.messages[0]).toMatchObject({ id: "replay-user-0", role: "user", text: "hi", complete: true });
    expect(s.messages[1]).toMatchObject({ id: "replay-assistant-1", role: "assistant", text: "hello!", complete: true });
  });

  test("legacy `hydrate` action still works (same semantics as refetched)", () => {
    let s = seed();
    s = chatReducer(s, {
      kind: "hydrate",
      chatId: CHAT,
      messages: [{ role: "user", content: "yo" }],
    });
    expect(s.messages.length).toBe(1);
    expect(s.messages[0].text).toBe("yo");
  });

  test("refetched is ignored when chatId no longer matches (race-safety)", () => {
    let s = chatReducer(seed(), { kind: "set_chat", chatId: "c2" });
    const before = s;
    s = chatReducer(s, {
      kind: "refetched",
      chatId: CHAT,
      messages: [{ role: "user", content: "stale" }],
    });
    expect(s).toBe(before);
  });

  test("refetched also clears live overlay (canonical state takes over)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "live" }));
    expect(s.liveTokens).toBe("live");
    s = chatReducer(s, {
      kind: "refetched",
      chatId: CHAT,
      messages: [{ role: "assistant", content: "canonical" }],
    });
    expect(s.liveTokens).toBe("");
    expect(s.messages[0].text).toBe("canonical");
  });
});
