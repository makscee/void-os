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
});
