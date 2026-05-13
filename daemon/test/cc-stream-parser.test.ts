import { describe, expect, test } from "bun:test";
import { createStreamParser } from "../src/adapters/cc/parser.js";

describe("createStreamParser", () => {
  test("emits one parsed event per JSON line", () => {
    const out: Array<{ kind: string; event?: unknown; line?: string; warning?: unknown }> = [];
    const p = createStreamParser({
      onEvent: (e) => out.push({ kind: "event", event: e }),
      onNoise: (l) => out.push({ kind: "noise", line: l }),
      onSession: (id) => out.push({ kind: "session", event: id }),
      onWarning: (w) => out.push({ kind: "warning", warning: w }),
    });
    p.feed(Buffer.from('{"type":"system","subtype":"init","session_id":"abc"}\n'));
    p.feed(Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n'));
    expect(out.map((o) => o.kind)).toEqual(["session", "event", "event"]);
    expect(out[0]!.event).toBe("abc");
    expect((out[1]!.event as { type: string }).type).toBe("system");
    expect((out[2]!.event as { type: string }).type).toBe("assistant");
  });

  test("buffers partial lines across feed() calls", () => {
    const events: unknown[] = [];
    const p = createStreamParser({
      onEvent: (e) => events.push(e),
      onNoise: () => {},
      onSession: () => {},
      onWarning: () => {},
    });
    p.feed(Buffer.from('{"type":"a"'));
    p.feed(Buffer.from(',"x":1}\n{"type":"b"}\n'));
    expect(events).toHaveLength(2);
    expect((events[0] as { type: string }).type).toBe("a");
    expect((events[1] as { type: string }).type).toBe("b");
  });

  test("non-JSON lines go to onNoise", () => {
    const noise: string[] = [];
    const events: unknown[] = [];
    const p = createStreamParser({
      onEvent: (e) => events.push(e),
      onNoise: (l) => noise.push(l),
      onSession: () => {},
      onWarning: () => {},
    });
    p.feed(Buffer.from("claudev 0.2.18 (en)\n"));
    p.feed(Buffer.from("welcome, user\n"));
    p.feed(Buffer.from('{"type":"system","session_id":"s"}\n'));
    expect(noise).toEqual(["claudev 0.2.18 (en)", "welcome, user"]);
    expect(events).toHaveLength(1);
  });

  test("tracks openToolUseIds set across tool_use / tool_result content blocks", () => {
    const p = createStreamParser({ onEvent: () => {}, onNoise: () => {}, onSession: () => {}, onWarning: () => {} });
    expect(p.inToolCall()).toBe(0);

    // assistant message with a tool_use content block
    p.feed(Buffer.from(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: {} }] },
    }) + "\n"));
    expect(p.inToolCall()).toBe(1);

    p.feed(Buffer.from(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool_2", name: "Read", input: {} }] },
    }) + "\n"));
    expect(p.inToolCall()).toBe(2);

    // user message carrying tool_result for tool_1
    p.feed(Buffer.from(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool_1", content: "ok" }] },
    }) + "\n"));
    expect(p.inToolCall()).toBe(1);

    // tool_result for tool_2
    p.feed(Buffer.from(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool_2", content: "ok" }] },
    }) + "\n"));
    expect(p.inToolCall()).toBe(0);
  });

  test("unknown tool_result id emits warning and leaves set unchanged", () => {
    const warnings: Array<{ reason: string; id?: string }> = [];
    const p = createStreamParser({
      onEvent: () => {}, onNoise: () => {}, onSession: () => {},
      onWarning: (w) => warnings.push(w),
    });
    p.feed(Buffer.from(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ghost", content: "?" }] },
    }) + "\n"));
    expect(p.inToolCall()).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.reason).toBe("unknown_tool_result_id");
    expect(warnings[0]!.id).toBe("ghost");
  });

  test("lastEventType and lastEventTs update on each event", () => {
    const p = createStreamParser({ onEvent: () => {}, onNoise: () => {}, onSession: () => {}, onWarning: () => {} });
    expect(p.lastEventTs()).toBe(0);
    p.feed(Buffer.from('{"type":"assistant"}\n'));
    const ts1 = p.lastEventTs();
    expect(ts1).toBeGreaterThan(0);
    expect(p.lastEventType()).toBe("assistant");
  });

  test("flush() emits any buffered partial line if it parses; otherwise noise", () => {
    const events: unknown[] = [];
    const noise: string[] = [];
    const p = createStreamParser({ onEvent: (e) => events.push(e), onNoise: (l) => noise.push(l), onSession: () => {}, onWarning: () => {} });
    p.feed(Buffer.from('{"type":"a"}'));      // no newline
    p.flush();
    expect(events).toHaveLength(1);

    const p2 = createStreamParser({ onEvent: (e) => events.push(e), onNoise: (l) => noise.push(l), onSession: () => {}, onWarning: () => {} });
    p2.feed(Buffer.from("trailing not-json"));
    p2.flush();
    expect(noise[noise.length - 1]).toBe("trailing not-json");
  });
});
