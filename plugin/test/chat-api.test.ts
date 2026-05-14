import { describe, test, expect } from "bun:test";
import { ApiError, makeChatApi } from "../src/chat/api";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  };
}

describe("makeChatApi", () => {
  test("createChat POSTs /chats with default agent and parses JSON", async () => {
    const calls: { url: string; body?: string }[] = [];
    const api = makeChatApi(
      "http://test",
      fakeFetch((url, init) => {
        calls.push({ url, body: init?.body as string });
        return new Response(
          JSON.stringify({ id: "c1", title: "untitled", created_at: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any,
    );
    const r = await api.createChat();
    expect(r).toEqual({ id: "c1", title: "untitled", created_at: 1 });
    expect(calls[0].url).toBe("http://test/chats");
    expect(JSON.parse(calls[0].body!)).toEqual({ agent: "maya" });
  });

  test("postMessage POSTs /chat/:id/message with text body", async () => {
    let captured: any = null;
    const api = makeChatApi(
      "http://test",
      fakeFetch((_url, init) => {
        captured = { url: _url, body: init?.body };
        return new Response(JSON.stringify({ run_id: "r1", status: "running" }), { status: 200 });
      }) as any,
    );
    const r = await api.postMessage("c1", "hello");
    expect(r).toEqual({ run_id: "r1", status: "running" });
    expect(captured.url).toBe("http://test/chat/c1/message");
    expect(JSON.parse(captured.body)).toEqual({ text: "hello" });
  });

  test("non-2xx throws ApiError carrying status + parsed body", async () => {
    const api = makeChatApi(
      "http://test",
      fakeFetch(() =>
        new Response(JSON.stringify({ error: "run_in_progress", current_run_id: "r9" }), { status: 409 }),
      ) as any,
    );
    await expect(api.postMessage("c1", "x")).rejects.toBeInstanceOf(ApiError);
    try {
      await api.postMessage("c1", "x");
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(409);
      expect(err.body).toEqual({ error: "run_in_progress", current_run_id: "r9" });
    }
  });

  test("encodes chatId in URL", async () => {
    let url = "";
    const api = makeChatApi(
      "http://test",
      fakeFetch((u) => { url = u; return new Response("{}", { status: 200 }); }) as any,
    );
    await api.postMessage("c/with slash", "x");
    expect(url).toBe("http://test/chat/c%2Fwith%20slash/message");
  });

  test("listChats GETs /chats and normalizes summaries", async () => {
    let captured = "";
    let method = "";
    const api = makeChatApi(
      "http://test",
      fakeFetch((url, init) => {
        captured = url;
        method = (init?.method ?? "GET").toUpperCase();
        return new Response(
          JSON.stringify([
            { id: "c1", agent: "maya", title: null, last_msg: "hi", updated_at: 100, last_run_status: "done" },
            { id: "c2", agent: "maya", title: "Trip", last_msg: "ok", updated_at: 50, last_run_status: null },
            { junk: true }, // dropped — no string id
          ]),
          { status: 200 },
        );
      }) as any,
    );
    const rows = await api.listChats();
    expect(method).toBe("GET");
    expect(captured).toBe("http://test/chats");
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      id: "c1", agent: "maya", title: null, last_msg: "hi", updated_at: 100, last_run_status: "done",
    });
    expect(rows[1].title).toBe("Trip");
    expect(rows[1].last_run_status).toBeNull();
  });

  test("listChats tolerates non-array body", async () => {
    const api = makeChatApi(
      "http://test",
      fakeFetch(() => new Response("null", { status: 200 })) as any,
    );
    expect(await api.listChats()).toEqual([]);
  });

  test("getMessages GETs /chat/:id/messages and normalizes replay rows", async () => {
    let url = "";
    const api = makeChatApi(
      "http://test",
      fakeFetch((u) => {
        url = u;
        return new Response(
          JSON.stringify([
            { role: "user", content: "hi", ts: 1 },
            { role: "assistant", content: "hello" },
            { role: "system", content: "ignored" }, // dropped
            { role: "user" }, // no string content — dropped
          ]),
          { status: 200 },
        );
      }) as any,
    );
    const rows = await api.getMessages("c1");
    expect(url).toBe("http://test/chat/c1/messages");
    expect(rows).toEqual([
      { role: "user", content: "hi", ts: 1 },
      { role: "assistant", content: "hello", ts: undefined },
    ]);
  });

  test("getMessages preserves tool_use and tool_result replay entries", async () => {
    // Real daemon shape: heterogeneous array with tool entries interleaved.
    // Regression: prior normalizer dropped non-user/assistant rows, which
    // made the S4 tool panel disappear after reload (hydrate had no tools).
    const api = makeChatApi(
      "http://test",
      fakeFetch(() =>
        new Response(
          JSON.stringify([
            { role: "user", content: "ls /tmp" },
            {
              role: "tool_use",
              tool_call_id: "tu1",
              name: "Bash",
              input: { command: "ls /tmp" },
            },
            {
              role: "tool_result",
              tool_call_id: "tu1",
              output: "file1\nfile2",
              is_error: false,
            },
            {
              role: "tool_result",
              tool_call_id: "tu2",
              output: [{ type: "text", text: "blocky" }],
              is_error: true,
            },
            { role: "assistant", content: "done" },
            { role: "tool_use", name: "Bash" }, // dropped — no tool_call_id
            { role: "tool_result" }, // dropped — no tool_call_id
          ]),
          { status: 200 },
        ),
      ) as any,
    );
    const rows = await api.getMessages("c1");
    expect(rows).toEqual([
      { role: "user", content: "ls /tmp", ts: undefined },
      {
        role: "tool_use",
        tool_call_id: "tu1",
        name: "Bash",
        input: { command: "ls /tmp" },
        ts: undefined,
      },
      {
        role: "tool_result",
        tool_call_id: "tu1",
        output: "file1\nfile2",
        is_error: false,
        ts: undefined,
      },
      {
        role: "tool_result",
        tool_call_id: "tu2",
        output: [{ type: "text", text: "blocky" }],
        is_error: true,
        ts: undefined,
      },
      { role: "assistant", content: "done", ts: undefined },
    ]);
  });

  test("getMessages encodes chatId", async () => {
    let url = "";
    const api = makeChatApi(
      "http://test",
      fakeFetch((u) => { url = u; return new Response("[]", { status: 200 }); }) as any,
    );
    await api.getMessages("c/with slash");
    expect(url).toBe("http://test/chat/c%2Fwith%20slash/messages");
  });

  test("getMessages surfaces ApiError on non-2xx", async () => {
    const api = makeChatApi(
      "http://test",
      fakeFetch(() => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as any,
    );
    await expect(api.getMessages("missing")).rejects.toBeInstanceOf(ApiError);
  });

  test("cancel POSTs /chat/:id/cancel and returns body on 200", async () => {
    let captured: { url: string; method?: string } = { url: "" };
    const api = makeChatApi(
      "http://test",
      fakeFetch((u, init) => {
        captured = { url: u, method: init?.method };
        return new Response(
          JSON.stringify({ run_id: "r5", status: "cancelled" }),
          { status: 200 },
        );
      }) as any,
    );
    const r = await api.cancel("c1");
    expect(captured.url).toBe("http://test/chat/c1/cancel");
    expect(captured.method).toBe("POST");
    expect(r).toEqual({ run_id: "r5", status: "cancelled" });
  });

  test("cancel returns {noActiveRun:true} on 409 (no throw)", async () => {
    const api = makeChatApi(
      "http://test",
      fakeFetch(() =>
        new Response(JSON.stringify({ error: "no_active_run" }), { status: 409 }),
      ) as any,
    );
    const r = await api.cancel("c1");
    expect(r).toEqual({ noActiveRun: true });
  });

  test("cancel throws ApiError on 404", async () => {
    const api = makeChatApi(
      "http://test",
      fakeFetch(() =>
        new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      ) as any,
    );
    await expect(api.cancel("missing")).rejects.toBeInstanceOf(ApiError);
  });

  test("cancel encodes chatId", async () => {
    let url = "";
    const api = makeChatApi(
      "http://test",
      fakeFetch((u) => {
        url = u;
        return new Response(JSON.stringify({ run_id: "r", status: "cancelled" }), { status: 200 });
      }) as any,
    );
    await api.cancel("c/with slash");
    expect(url).toBe("http://test/chat/c%2Fwith%20slash/cancel");
  });
});
