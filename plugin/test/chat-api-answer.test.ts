import { describe, it, expect } from "bun:test";
import { makeChatApi } from "../src/chat/api";

function fakeFetch(responses: Array<{ status: number; body?: unknown }>): typeof fetch {
  let i = 0;
  return (async (_url, _init) => {
    const r = responses[i++];
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("ChatApi.answer", () => {
  it("returns {ok:true} on 200", async () => {
    const api = makeChatApi("http://test", fakeFetch([{ status: 200, body: { ok: true } }]));
    const r = await api.answer("chat-1", "tool-1", "red");
    expect(r).toEqual({ ok: true });
  });

  it("returns {ok:false, status:409} on 409 with no throw", async () => {
    const api = makeChatApi("http://test", fakeFetch([{ status: 409, body: { error: "no_match" } }]));
    const r = await api.answer("chat-1", "tool-1", "red");
    expect(r).toEqual({ ok: false, status: 409, error: "no_match" });
  });

  it("returns {ok:false, status:400} on 400", async () => {
    const api = makeChatApi("http://test", fakeFetch([{ status: 400, body: { error: "invalid_body" } }]));
    const r = await api.answer("c", "t", "x");
    expect(r).toEqual({ ok: false, status: 400, error: "invalid_body" });
  });

  it("returns {ok:false, status:404} on 404", async () => {
    const api = makeChatApi("http://test", fakeFetch([{ status: 404, body: { error: "chat_not_found" } }]));
    const r = await api.answer("c", "t", "x");
    expect(r).toEqual({ ok: false, status: 404, error: "chat_not_found" });
  });

  it("throws on network error (caller distinguishes from 4xx)", async () => {
    const api = makeChatApi("http://test", (() => { throw new TypeError("net"); }) as unknown as typeof fetch);
    await expect(api.answer("c", "t", "x")).rejects.toThrow();
  });

  it("URL-encodes the chatId", async () => {
    let seen = "";
    const f = (async (url) => {
      seen = String(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const api = makeChatApi("http://base", f);
    await api.answer("a/b c", "t", "x");
    expect(seen).toBe("http://base/chat/a%2Fb%20c/answer");
  });
});
