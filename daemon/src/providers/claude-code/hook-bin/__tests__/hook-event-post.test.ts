// VOS-162: tests for the best-effort hook → daemon event poster.
//
// The two invariants that protect a CC tool call:
//   - never throws (a dead daemon must not fail the permission hook)
//   - skips silently when the spawn env is missing the daemon coordinates

import { describe, expect, test } from "bun:test";
import { postHookEvent } from "../hook-event-post.ts";

describe("VOS-162: postHookEvent", () => {
  test("POSTs the event to /agents/hook-event with the agent identity", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      captured = { url, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await postHookEvent(
      { kind: "tool_call", tool: "Bash", summary: "PreToolUse Bash" },
      { VOS_DAEMON_BASE: "http://127.0.0.1:7777", VOS_HOOK_AGENT_ID: "task-9" },
      fakeFetch,
    );
    expect(ok).toBe(true);
    expect(captured!.url).toBe("http://127.0.0.1:7777/agents/hook-event");
    expect(captured!.body).toMatchObject({
      agent_id: "task-9",
      kind: "tool_call",
      tool: "Bash",
    });
  });

  test("skips silently when VOS_DAEMON_BASE is unset", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await postHookEvent(
      { kind: "tool_call", summary: "x" },
      { VOS_HOOK_AGENT_ID: "task-9" },
      fakeFetch,
    );
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  test("skips silently when VOS_HOOK_AGENT_ID is unset", async () => {
    const ok = await postHookEvent(
      { kind: "tool_call", summary: "x" },
      { VOS_DAEMON_BASE: "http://127.0.0.1:7777" },
    );
    expect(ok).toBe(false);
  });

  test("never throws when the daemon is unreachable", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const ok = await postHookEvent(
      { kind: "tool_return", summary: "x" },
      { VOS_DAEMON_BASE: "http://127.0.0.1:7777", VOS_HOOK_AGENT_ID: "task-9" },
      fakeFetch,
    );
    expect(ok).toBe(false);
  });

  test("returns false on a non-2xx daemon response", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const ok = await postHookEvent(
      { kind: "tool_call", summary: "x" },
      { VOS_DAEMON_BASE: "http://127.0.0.1:7777", VOS_HOOK_AGENT_ID: "task-9" },
      fakeFetch,
    );
    expect(ok).toBe(false);
  });
});
