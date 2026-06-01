// tests/chat.test.ts — unit tests for src/chat.ts (ADR-0003 §4 chat-as-file)
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatEvent, readTranscript, appendReply, appendUserMessage, chatColdContext, chatPreSpawn } from "../src/chat.ts";
import { chatThreadPath } from "../src/paths.ts";

function mkVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vos-chat-"));
  mkdirSync(join(v, "chat"), { recursive: true });
  return v;
}

// parseChatEvent — bus format (real bus line format with channel + payload + routing.thread)
test("parseChatEvent extracts thread + text from a bus-format kind:chat line", () => {
  const ev = parseChatEvent(JSON.stringify({
    channel: "file", kind: "chat", payload: "hi there",
    routing: { thread: "general" }, id: "bl-1", ts: 5000,
  }));
  expect(ev).not.toBeNull();
  expect(ev!.thread).toBe("general");
  expect(ev!.text).toBe("hi there");
  expect(ev!.at).toBe(5000);
});

// parseChatEvent — legacy format (plan-spec + ChatEvent compat)
test("parseChatEvent extracts thread + text from a legacy kind:chat line", () => {
  const ev = parseChatEvent(JSON.stringify({ kind: "chat", thread: "general", text: "hi there", at: 5 }));
  expect(ev).toEqual({ thread: "general", text: "hi there", at: 5 });
});

test("parseChatEvent returns null for non-chat lines", () => {
  expect(parseChatEvent(JSON.stringify({ channel: "file", kind: "idea", payload: "x", routing: {} }))).toBeNull();
  expect(parseChatEvent("not json")).toBeNull();
});

test("parseChatEvent returns null when thread or text is missing", () => {
  // missing thread in routing
  expect(parseChatEvent(JSON.stringify({ channel: "file", kind: "chat", payload: "x", routing: {} }))).toBeNull();
  // missing payload
  expect(parseChatEvent(JSON.stringify({ channel: "file", kind: "chat", routing: { thread: "t" } }))).toBeNull();
  // legacy: missing thread
  expect(parseChatEvent(JSON.stringify({ kind: "chat", text: "x" }))).toBeNull();
  // legacy: missing text
  expect(parseChatEvent(JSON.stringify({ kind: "chat", thread: "t" }))).toBeNull();
});

test("appendUserMessage then readTranscript round-trips the user turn", () => {
  const v = mkVault();
  appendUserMessage(v, "general", "hello", 1000);
  const t = readTranscript(v, "general");
  expect(t).toContain("## user");
  expect(t).toContain("hello");
});

test("appendReply appends an assistant turn to the same file", () => {
  const v = mkVault();
  appendUserMessage(v, "general", "hello", 1000);
  appendReply(v, "general", "hi back", 2000);
  const t = readFileSync(chatThreadPath(v, "general"), "utf8");
  expect(t.indexOf("## user")).toBeLessThan(t.indexOf("## assistant"));
  expect(t).toContain("hi back");
});

test("readTranscript returns empty string for a thread with no file yet", () => {
  const v = mkVault();
  expect(readTranscript(v, "nope")).toBe("");
});

test("chatColdContext reports bytes + a token estimate (~bytes/4)", () => {
  const v = mkVault();
  writeFileSync(chatThreadPath(v, "general"), "x".repeat(400));
  const c = chatColdContext(v, "general");
  expect(c.bytes).toBe(400);
  expect(c.tokenEstimate).toBe(100); // ceil(bytes/4)
});

test("chatColdContext is zero for a missing thread file", () => {
  const v = mkVault();
  expect(chatColdContext(v, "nope")).toEqual({ bytes: 0, tokenEstimate: 0 });
});

test("chatPreSpawn deposits the user turn and returns the thread file as input_ref (legacy format)", () => {
  const v = mkVault();
  const line = JSON.stringify({ kind: "chat", thread: "general", text: "ping", at: 3000 });
  const res = chatPreSpawn(v, line);
  expect(res).not.toBeNull();
  expect(res!.inputRef).toBe(chatThreadPath(v, "general"));
  expect(readFileSync(chatThreadPath(v, "general"), "utf8")).toContain("ping");
});

test("chatPreSpawn deposits the user turn from a bus-format line", () => {
  const v = mkVault();
  const line = JSON.stringify({
    channel: "file", kind: "chat", payload: "bus-ping",
    routing: { thread: "my-thread" }, id: "bl-99", ts: 4000,
  });
  const res = chatPreSpawn(v, line);
  expect(res).not.toBeNull();
  expect(res!.inputRef).toBe(chatThreadPath(v, "my-thread"));
  expect(readFileSync(chatThreadPath(v, "my-thread"), "utf8")).toContain("bus-ping");
});

test("chatPreSpawn returns null for a non-chat line", () => {
  const v = mkVault();
  expect(chatPreSpawn(v, JSON.stringify({ channel: "file", kind: "idea", payload: "x", routing: {} }))).toBeNull();
});
