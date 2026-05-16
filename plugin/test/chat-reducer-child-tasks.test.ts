// VOS-91 T11 — ChildTaskStream types + ChatState.childTasks / toolCallToChild
// shape contract for initialChatState.

import { describe, test, expect } from "bun:test";
import {
  initialChatState,
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
