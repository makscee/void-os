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
});
