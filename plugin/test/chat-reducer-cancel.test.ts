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
    s = chatReducer(s, frame({ type: "chat.completion", chat_id: CHAT, run_id: RUN }));
    // chat.completion is a no-op now — overlay still present until run.end.
    expect(s.liveTokens).toBe("ok");
    expect(s.runState).toBe("running");
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" }));
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
    expect(s.liveTokens).toBe("");
    expect(s.pendingStoppedRunId).toBeNull();
  });

  test("run.end{done} without chat.completion still clears + idles (defensive)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "x" }));
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" }));
    expect(s.runState).toBe("idle");
    expect(s.liveTokens).toBe("");
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
