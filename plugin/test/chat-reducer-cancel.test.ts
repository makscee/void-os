// VOS-80 part 2 — reducer cancel-path semantics under the
// daemon-DB-as-truth model.
//
// Contract pinned here:
//   - run.end{status:"cancelled"} flips runState → "idle", clears overlay
//     (liveTokens / liveToolEvents / activeRunId), and arms
//     pendingStoppedRunId so the runtime's refetched dispatch tags the
//     last assistant entry as cancelled.
//   - run.end{status:"done"} → idle + clears overlay; no pendingStoppedRunId.
//   - local_cancel (optimistic ESC) flips idle + clears overlay + arms
//     pendingStoppedRunId. The follow-up run.end{cancelled} frame is a
//     no-op against the already-armed state.
//   - run.end{error} → runState "error" + clears overlay.
//   - refetched with stoppedRunId tags the last assistant message
//     cancelled=true and clears pendingStoppedRunId.

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

describe("chatReducer — cancel path (VOS-80 part 2)", () => {
  test("run.end{cancelled} flips idle, clears overlay, arms pendingStoppedRunId", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "Hel" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "lo" }));
    expect(s.liveTokens).toBe("Hello");
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "cancelled" }));
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
    expect(s.liveTokens).toBe("");
    expect(s.liveToolEvents).toEqual([]);
    expect(s.pendingStoppedRunId).toBe(RUN);
    // Messages array is NOT mutated by run.end — refetch replaces it.
    expect(s.messages.length).toBe(0);
  });

  test("run.end{done} clears overlay + idle + no pendingStoppedRunId", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "ok" }));
    expect(s.liveTokens).toBe("ok");
    expect(s.runState).toBe("running");
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" }));
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
    expect(s.liveTokens).toBe("");
    expect(s.pendingStoppedRunId).toBeNull();
  });

  test("local_cancel flips idle, KEEPS overlay (until run.end), arms pendingStoppedRunId", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "partial" }));
    s = chatReducer(s, { kind: "local_cancel" });
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
    // Overlay PRESERVED so the renderer can show the partial bubble + the
    // (stopped) badge between local_cancel and the daemon's run.end.
    expect(s.liveTokens).toBe("partial");
    expect(s.pendingStoppedRunId).toBe(RUN);
  });

  test("local_cancel then run.end{cancelled} clears overlay; pending preserved for refetch tagging", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "y" }));
    const before = chatReducer(s, { kind: "local_cancel" });
    expect(before.pendingStoppedRunId).toBe(RUN);
    expect(before.liveTokens).toBe("y");
    const after = chatReducer(before, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "cancelled" }));
    expect(after.runState).toBe("idle");
    expect(after.activeRunId).toBeNull();
    expect(after.pendingStoppedRunId).toBe(RUN);
    // run.end is authoritative — overlay clears, refetch is about to land.
    expect(after.liveTokens).toBe("");
  });

  test("local_cancel is a no-op when not running", () => {
    const s0 = seed();
    const s1 = chatReducer(s0, { kind: "local_cancel" });
    expect(s1).toBe(s0);
  });

  // VOS-80 stopped-badge fix (1): badge must appear IMMEDIATELY on ESC,
  // not after the daemon round-trip. When overlay is empty (no tokens
  // streamed yet), local_cancel synthesizes a placeholder cancelled
  // assistant directly into messages so the bubble renders this frame.
  test("local_cancel with empty overlay + tail=user: synthesizes cancelled assistant immediately", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    // Simulate a user prompt in messages (e.g. from an earlier refetch).
    s = {
      ...s,
      messages: [
        { id: "u1", role: "user", text: "test123", complete: true },
      ],
    };
    s = chatReducer(s, { kind: "local_cancel" });
    expect(s.runState).toBe("idle");
    expect(s.pendingStoppedRunId).toBe(RUN);
    // Synthesized cancelled assistant appended after the user prompt.
    expect(s.messages).toHaveLength(2);
    const last = s.messages[s.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.cancelled).toBe(true);
    expect(last.text).toBe("");
    expect(last.parts).toEqual([]);
  });

  test("local_cancel with empty overlay + tail=assistant: tags that assistant cancelled in place", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = {
      ...s,
      messages: [
        { id: "a1", role: "assistant", text: "earlier reply", complete: true },
      ],
    };
    s = chatReducer(s, { kind: "local_cancel" });
    // No new bubble — the existing assistant is tagged cancelled in place.
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].cancelled).toBe(true);
    expect(s.messages[0].text).toBe("earlier reply");
  });

  test("local_cancel with overlay content: does NOT synthesize (overlay handles bubble + badge)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "streamed " }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "text" }));
    const before = s.messages.length;
    s = chatReducer(s, { kind: "local_cancel" });
    // messages array UNCHANGED — overlay (driven by pendingStoppedRunId +
    // liveTokens) renders the partial bubble with badge. Adding to
    // messages would double-bubble.
    expect(s.messages).toHaveLength(before);
    expect(s.pendingStoppedRunId).toBe(RUN);
    expect(s.liveTokens).toBe("streamed text");
  });

  test("local_cancel synth + subsequent refetch with daemon-persisted empty cancelled row: no double-bubble", () => {
    // Race scenario: ESC fires before any tokens. local_cancel synthesizes
    // a placeholder. Daemon's finally-block now persists an empty
    // cancelled assistant row (VOS-80 fix b). The refetch returns BOTH the
    // user prompt AND the persisted empty cancelled row. replayToMessages
    // wholesale-replaces messages — synthesized placeholder is discarded
    // cleanly, daemon truth wins. Exactly one cancelled assistant entry.
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = {
      ...s,
      messages: [{ id: "u1", role: "user", text: "test123", complete: true }],
    };
    s = chatReducer(s, { kind: "local_cancel" });
    // Optimistic synth present.
    expect(s.messages.filter((m) => m.role === "assistant").length).toBe(1);

    // Daemon's run.end + refetch lands.
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "cancelled" }));
    s = chatReducer(s, {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        { role: "user", content: "test123" },
        // Daemon's persisted empty cancelled row, surfaced via JOIN.
        { role: "assistant", content: "", cancelled: true },
      ],
      stoppedRunId: RUN,
    });
    // Exactly ONE cancelled assistant, no duplicates.
    const cancelledAssistants = s.messages.filter(
      (m) => m.role === "assistant" && m.cancelled === true,
    );
    expect(cancelledAssistants).toHaveLength(1);
    expect(s.messages).toHaveLength(2);
    expect(s.pendingStoppedRunId).toBeNull();
  });

  test("chat-switch + return mid-cancel: refetched empty cancelled row restores badge", () => {
    // Bug 2 scenario: ESC → badge → switch chat → switch back. Optimistic
    // state is gone (set_chat resets everything). On return, the daemon's
    // persisted empty cancelled row hydrates the bubble back.
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, { kind: "local_cancel" });
    // User switches chats — state is reset.
    s = chatReducer(s, { kind: "set_chat", chatId: "c2" });
    // ... and back.
    s = chatReducer(s, { kind: "set_chat", chatId: CHAT });
    // Hydrate with the daemon's persisted history.
    s = chatReducer(s, {
      kind: "hydrate",
      chatId: CHAT,
      messages: [
        { role: "user", content: "test123" },
        { role: "assistant", content: "", cancelled: true },
      ],
    });
    const last = s.messages[s.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.cancelled).toBe(true);
    expect(last.text).toBe("");
  });

  test("run.end{error} flips error + clears overlay + no pendingStoppedRunId", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "p" }));
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "error", error: "boom" }));
    expect(s.runState).toBe("error");
    expect(s.liveTokens).toBe("");
    expect(s.pendingStoppedRunId).toBeNull();
  });

  test("cancel before any tokens: idle, no overlay, pending armed (anchors next refetch)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "cancelled" }));
    expect(s.runState).toBe("idle");
    expect(s.pendingStoppedRunId).toBe(RUN);
    expect(s.liveTokens).toBe("");
  });

  test("refetched with stoppedRunId tags the last assistant cancelled + clears pending", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "partial" }));
    s = chatReducer(s, { kind: "local_cancel" });
    expect(s.pendingStoppedRunId).toBe(RUN);
    s = chatReducer(s, {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "partial" },
      ],
      stoppedRunId: RUN,
    });
    const a = s.messages.find((m) => m.role === "assistant")!;
    expect(a.cancelled).toBe(true);
    expect(s.pendingStoppedRunId).toBeNull();
  });

  test("refetched with stoppedRunId BUT no assistant row (ESC before any tokens): synthesizes empty cancelled assistant AFTER the user prompt", () => {
    // Reproducer for the badge-on-wrong-message bug: ESC fires immediately
    // after user sends "test123". Daemon never persists an assistant row
    // (no tokens streamed → orchestrator's appendAssistant is skipped).
    // The refetch returns only the prior successful turn + the new user
    // prompt. Old behavior tagged the PRIOR assistant cancelled — wrong.
    // New behavior appends a synthetic empty cancelled assistant entry
    // AFTER the user prompt so the badge attaches to the correct turn.
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, { kind: "local_cancel" });
    expect(s.pendingStoppedRunId).toBe(RUN);
    s = chatReducer(s, {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        { role: "user", content: "earlier prompt" },
        { role: "assistant", content: "Hi. What task?" },
        { role: "user", content: "test123" },
      ],
      stoppedRunId: RUN,
    });
    // Synthesized empty cancelled assistant appended at tail.
    const last = s.messages[s.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.cancelled).toBe(true);
    expect(last.parts).toEqual([]);
    // PRIOR assistant ("Hi. What task?") is NOT tagged cancelled — that
    // was the visual bug.
    const prior = s.messages.find(
      (m) => m.role === "assistant" && m !== last,
    )!;
    expect(prior.cancelled ?? false).toBe(false);
    // Order: ...user "test123" → synthetic cancelled assistant
    expect(s.messages[s.messages.length - 2].role).toBe("user");
    expect((s.messages[s.messages.length - 2] as { text: string }).text).toBe("test123");
    expect(s.pendingStoppedRunId).toBeNull();
  });

  test("refetched without stoppedRunId leaves messages untagged", () => {
    let s = chatReducer(seed(), {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
      ],
    });
    const a = s.messages.find((m) => m.role === "assistant")!;
    expect(a.cancelled ?? false).toBe(false);
  });

  test("run.end{status:error,error:timeout} arms timeout errorNotice", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "run.end", chat_id: CHAT, run_id: RUN,
      status: "error", error: "watchdog timeout (phase=first_event idle=15000)",
    }));
    expect(s.runState).toBe("error");
    expect(s.errorNotice).toEqual({ kind: "timeout", runId: RUN });
  });

  test("run.end{status:error,error:other} arms generic errorNotice", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "run.end", chat_id: CHAT, run_id: RUN,
      status: "error", error: "permission denied",
    }));
    expect(s.errorNotice).toEqual({ kind: "generic", runId: RUN });
  });

  test("run.end{status:done} clears any prior errorNotice", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "run.end", chat_id: CHAT, run_id: RUN,
      status: "error", error: "timeout",
    }));
    expect(s.errorNotice?.kind).toBe("timeout");
    // Next run starts fresh, errorNotice cleared.
    s = chatReducer(s, frame({ type: "run.start", chat_id: CHAT, run_id: "r2", agent: "maya" }));
    expect(s.errorNotice).toBeNull();
  });

  test("run.error frame arms errorNotice", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "run.error", chat_id: CHAT, run_id: RUN, error: "no_response timeout" }));
    expect(s.runState).toBe("error");
    expect(s.errorNotice).toEqual({ kind: "timeout", runId: RUN });
  });

  test("user_send clears errorNotice (user retry)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({
      type: "run.end", chat_id: CHAT, run_id: RUN,
      status: "error", error: "timeout",
    }));
    expect(s.errorNotice).not.toBeNull();
    s = chatReducer(s, { kind: "user_send", text: "retry", tempId: "t1" });
    expect(s.errorNotice).toBeNull();
  });

  test("run.end{cancelled} does NOT arm errorNotice (cancelled is its own visual cue)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "cancelled" }));
    expect(s.errorNotice).toBeNull();
    expect(s.pendingStoppedRunId).toBe(RUN);
  });

  test("refetched propagates server-truth cancelled flag (daemon LEFT JOIN runs)", () => {
    // Even without stoppedRunId armed locally, an assistant entry tagged
    // cancelled:true by the daemon should mark the ChatMessage cancelled.
    // This is what makes the badge survive chat-switch + re-mount.
    const s = chatReducer(seed(), {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "partial", cancelled: true },
        { role: "user", content: "next" },
        { role: "assistant", content: "fresh answer" },
      ],
    });
    const assistants = s.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0].cancelled).toBe(true);
    // Second assistant entry from a non-cancelled run is NOT tagged.
    expect(assistants[1].cancelled ?? false).toBe(false);
  });
});
