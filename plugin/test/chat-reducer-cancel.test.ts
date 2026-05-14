// VOS-80 — reducer cancel-path semantics.
//
// Contract pinned here (real-time UI state must reflect cancel during the
// active session — not only after a chat-switch replay):
//   - run.end{status:"cancelled"} is the AUTHORITATIVE terminal frame.
//     Daemon (e81eb72) suppresses chat.completion on cancel, so run.end is
//     the only stream-end signal. Reducer MUST:
//       * flip runState → "idle"
//       * clear activeRunId
//       * mark the in-flight assistant message complete
//       * set the cancelled flag on the assistant message
//       * preserve partial text streamed before the cancel landed
//   - run.end{status:"done"} after chat.completion is idempotent (no
//     double-finalize, no spurious cancelled flag).
//   - run.end{status:"done"} WITHOUT a preceding chat.completion still
//     finalizes the assistant turn (defensive — daemon contract guarantees
//     chat.completion on done, but reducer should not panic).
//   - local_cancel (optimistic ESC dispatch) flips state idle + marks the
//     in-flight assistant cancelled. The subsequent run.end{cancelled}
//     frame is a no-op (idempotent).

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

describe("chatReducer — cancel path (VOS-80)", () => {
  test("run.end{cancelled} flips state idle + marks cancelled + preserves partial text", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "Hel" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "lo" }));
    // No chat.completion (daemon suppresses on cancel) — go straight to run.end.
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "cancelled" }));
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
    const a = s.messages.find((m) => m.role === "assistant");
    expect(a).toBeTruthy();
    expect(a!.text).toBe("Hello"); // partial text retained
    expect(a!.complete).toBe(true);
    expect(a!.cancelled).toBe(true);
  });

  test("run.end{done} after chat.completion is idempotent — no double-finalize, no cancelled flag", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "ok" }));
    s = chatReducer(s, frame({ type: "chat.completion", chat_id: CHAT, run_id: RUN }));
    const before = s.messages.find((m) => m.role === "assistant")!;
    expect(before.complete).toBe(true);
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" }));
    const after = s.messages.find((m) => m.role === "assistant")!;
    expect(after.complete).toBe(true);
    expect(after.cancelled ?? false).toBe(false);
    // markAssistantComplete returns the same array reference when idempotent.
    // We only assert observable state; the no-op preserves the message shape.
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
  });

  test("run.end{done} WITHOUT chat.completion still finalizes (defensive)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "x" }));
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" }));
    const a = s.messages.find((m) => m.role === "assistant")!;
    expect(a.complete).toBe(true);
    expect(a.cancelled ?? false).toBe(false);
    expect(s.runState).toBe("idle");
  });

  test("local_cancel flips idle + marks cancelled (optimistic ESC path)", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "partial" }));
    s = chatReducer(s, { kind: "local_cancel" });
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
    const a = s.messages.find((m) => m.role === "assistant")!;
    expect(a.text).toBe("partial");
    expect(a.complete).toBe(true);
    expect(a.cancelled).toBe(true);
  });

  test("local_cancel followed by run.end{cancelled} is idempotent", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "y" }));
    const before = chatReducer(s, { kind: "local_cancel" });
    const after = chatReducer(before, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "cancelled" }));
    expect(after.runState).toBe("idle");
    expect(after.activeRunId).toBeNull();
    const a = after.messages.find((m) => m.role === "assistant")!;
    expect(a.text).toBe("y");
    expect(a.complete).toBe(true);
    expect(a.cancelled).toBe(true);
  });

  test("local_cancel is a no-op when not running", () => {
    const s0 = seed();
    const s1 = chatReducer(s0, { kind: "local_cancel" });
    expect(s1).toBe(s0);
  });

  test("run.end{error} flips runState error (not idle) and does NOT set cancelled", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "chat.token", chat_id: CHAT, run_id: RUN, delta: "p" }));
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "error", error: "boom" }));
    expect(s.runState).toBe("error");
    const a = s.messages.find((m) => m.role === "assistant")!;
    expect(a.complete).toBe(true);
    expect(a.cancelled ?? false).toBe(false);
  });

  test("cancel before any tokens streamed: runState idle, no assistant message", () => {
    let s = chatReducer(seed(), frame({ type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" }));
    s = chatReducer(s, frame({ type: "run.end", chat_id: CHAT, run_id: RUN, status: "cancelled" }));
    expect(s.runState).toBe("idle");
    expect(s.activeRunId).toBeNull();
    // No assistant message exists (no tokens streamed), so cancelled flag has
    // nothing to attach to — that's expected; UI just shows no bubble.
    expect(s.messages.filter((m) => m.role === "assistant").length).toBe(0);
  });
});
