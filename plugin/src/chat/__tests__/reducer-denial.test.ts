// VOS-109 T4 — reducer round-trips DenialPart through:
//   (1) refetched replay (GET /chat/:id/messages → "denial" row variant)
//   (2) live chat.denial frame (daemon broadcast)
//
// The daemon now persists / broadcasts denials as
//   DataPart{data:{kind:"denial", toolCallId, reason, attemptedPath, agent, message}}
// (committed at 98558bd via T3). T6 will extend messages-repo to surface a
// "denial" replay row; this test pins the reducer's contract for that row
// shape ahead of time.
//
// On the live path, a future daemon broadcast emits a `chat.denial` frame
// (additive to bus.ts DaemonFrame union). Reducer routes it into liveDenials.

import { describe, test, expect } from "bun:test";
import {
  chatReducer,
  initialChatState,
  type ChatState,
  type DenialPart,
} from "../reducer";
import type { DaemonFrame } from "../bus";

const CHAT = "c1";
const RUN = "r1";

const seedRunning = (): ChatState => {
  const s = initialChatState(CHAT);
  return chatReducer(
    s,
    { kind: "frame", frame: { type: "run.start", chat_id: CHAT, run_id: RUN, agent: "maya" } },
  );
};

describe("chatReducer denial round-trip (VOS-109)", () => {
  test("refetched: 'denial' replay row materialises a DenialPart attached to the preceding assistant turn", () => {
    const s0 = initialChatState(CHAT);
    const s1 = chatReducer(s0, {
      kind: "refetched",
      chatId: CHAT,
      messages: [
        // Assistant text turn (creates the bubble denial attaches to).
        { role: "assistant", content: "trying to create the file" },
        // The offending tool_use + tool_result rows (pre-existing replay shapes).
        {
          role: "tool_use",
          tool_call_id: "tu-1",
          name: "vault.create",
          input: { path: "journal/forbidden.md", content: "x" },
        },
        {
          role: "tool_result",
          tool_call_id: "tu-1",
          output: "WRITE_SCOPE_DENIED: journal/forbidden.md outside write_scope for agent maya",
          is_error: true,
        },
        // NEW: denial replay row. Mirrors the daemon DataPart{data:{kind:"denial",...}}
        // persisted alongside the tool_result by run-driver's synthesiser.
        {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          role: "denial",
          tool_call_id: "tu-1",
          reason: "scope_violation",
          attempted_path: "journal/forbidden.md",
          agent: "maya",
          message: "Write denied: maya is not allowed to write journal/forbidden.md.",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    });

    // One assistant bubble accumulates all three trailing rows as parts.
    expect(s1.messages.length).toBe(1);
    const assistant = s1.messages[0];
    expect(assistant.role).toBe("assistant");
    const parts = assistant.parts ?? [];
    // text + tool (with output merged) + denial.
    const denialParts = parts.filter((p): p is DenialPart => p.kind === "denial");
    expect(denialParts.length).toBe(1);
    expect(denialParts[0]).toEqual({
      kind: "denial",
      toolCallId: "tu-1",
      reason: "scope_violation",
      attemptedPath: "journal/forbidden.md",
      agent: "maya",
      message: "Write denied: maya is not allowed to write journal/forbidden.md.",
    });
  });

  test("live frame: chat.denial routes a DenialPart into liveDenials overlay", () => {
    const s = seedRunning();
    expect(s.liveDenials).toEqual([]);

    // Live frame: daemon emits chat.denial after the offending tool_result.
    const denialFrame: DaemonFrame = {
      type: "chat.denial",
      chat_id: CHAT,
      run_id: RUN,
      tool_call_id: "tu-2",
      reason: "scope_violation",
      attempted_path: "a.md",
      agent: "maya",
      message: "Write denied: maya is not allowed to write a.md.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const s2 = chatReducer(s, { kind: "frame", frame: denialFrame });

    expect(s2.liveDenials.length).toBe(1);
    expect(s2.liveDenials[0]).toEqual({
      kind: "denial",
      toolCallId: "tu-2",
      reason: "scope_violation",
      attemptedPath: "a.md",
      agent: "maya",
      message: "Write denied: maya is not allowed to write a.md.",
    });

    // Idempotent on duplicate frame (same tool_call_id).
    const s3 = chatReducer(s2, { kind: "frame", frame: denialFrame });
    expect(s3.liveDenials.length).toBe(1);
  });

  test("live frame: chat.denial is cleared on run.end (overlay reset)", () => {
    let s: ChatState = seedRunning();
    s = chatReducer(s, {
      kind: "frame",
      frame: {
        type: "chat.denial",
        chat_id: CHAT,
        run_id: RUN,
        tool_call_id: "tu-3",
        reason: "scope_violation",
        attempted_path: "x.md",
        agent: "maya",
        message: "denied",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    expect(s.liveDenials.length).toBe(1);
    s = chatReducer(s, {
      kind: "frame",
      frame: { type: "run.end", chat_id: CHAT, run_id: RUN, status: "done" },
    });
    expect(s.liveDenials).toEqual([]);
  });
});
