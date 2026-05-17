import { test, expect } from "bun:test";
import { makeClient } from "./client.ts";

function fakeFetch(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return Promise.resolve(handler(req));
  };
}

test("chat.create posts to /chats with agent and returns {id, title, created_at}", async () => {
  let seen: Request | null = null;
  let body: any = null;
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch(async (req) => {
      seen = req;
      body = await req.json();
      return new Response(
        JSON.stringify({ id: "c_tinker", title: "Untitled", created_at: 1700000000000 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  });
  const r = await client.chat.create({ agent: "tinker" });
  expect(r.id).toBe("c_tinker");
  expect(r.title).toBe("Untitled");
  expect(seen!.method).toBe("POST");
  expect(new URL(seen!.url).pathname).toBe("/chats");
  expect(seen!.headers.get("authorization")).toBe("Bearer tok");
  expect(seen!.headers.get("content-type")).toContain("application/json");
  expect(body).toEqual({ agent: "tinker" });
});

test("chat.create accepts null title (daemon stub titler returns null)", async () => {
  // VOS-118 T8 regression: daemon `POST /chats` returns title:null when stub
  // titler is active (every fake-provider E2E run). Schema must tolerate it.
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch(async () =>
      new Response(
        JSON.stringify({ id: "c_null", title: null, created_at: 1700000000000 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  });
  const r = await client.chat.create({ agent: "tinker" });
  expect(r.id).toBe("c_null");
  expect(r.title).toBeNull();
});

test("chat.create with no agent posts empty body (daemon defaults to maya)", async () => {
  let body: any = null;
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch(async (req) => {
      body = await req.json();
      return new Response(
        JSON.stringify({ id: "c_maya", title: "Untitled", created_at: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  });
  const r = await client.chat.create();
  expect(r.id).toBe("c_maya");
  expect(body).toEqual({});
});

test("chat.send posts {text} to /chat/:id/message and returns {run_id}", async () => {
  let seen: Request | null = null;
  let body: any = null;
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch(async (req) => {
      seen = req;
      body = await req.json();
      return new Response(
        JSON.stringify({ run_id: "r_1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  });
  const r = await client.chat.send("c_x", "hello");
  expect(r.run_id).toBe("r_1");
  expect(seen!.method).toBe("POST");
  expect(new URL(seen!.url).pathname).toBe("/chat/c_x/message");
  expect(body).toEqual({ text: "hello" });
});

test("chat.send url-encodes the chat id", async () => {
  let url = "";
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch((req) => {
      url = new URL(req.url).pathname;
      return new Response(JSON.stringify({ run_id: "r" }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  });
  await client.chat.send("c with space", "hi");
  expect(url).toBe("/chat/c%20with%20space/message");
});

test("chat.answer posts {tool_use_id, answer} to /chat/:id/answer and returns {ok:true}", async () => {
  let seen: Request | null = null;
  let body: any = null;
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch(async (req) => {
      seen = req;
      body = await req.json();
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  });
  const r = await client.chat.answer("c_x", "tu_1", "yes");
  expect(r.ok).toBe(true);
  expect(seen!.method).toBe("POST");
  expect(new URL(seen!.url).pathname).toBe("/chat/c_x/answer");
  expect(body).toEqual({ tool_use_id: "tu_1", answer: "yes" });
});

test("chat.cancel posts to /chat/:id/cancel and returns {run_id, status}", async () => {
  let seen: Request | null = null;
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch((req) => {
      seen = req;
      return new Response(
        JSON.stringify({ run_id: "r_1", status: "cancelled" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  });
  const r = await client.chat.cancel("c_x");
  expect(r.status).toBe("cancelled");
  expect(r.run_id).toBe("r_1");
  expect(seen!.method).toBe("POST");
  expect(new URL(seen!.url).pathname).toBe("/chat/c_x/cancel");
});

test("chat.cancel surfaces 409 no_active_run as ApiError", async () => {
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch(() => new Response(
      JSON.stringify({ error: "no_active_run" }),
      { status: 409, headers: { "content-type": "application/json" } },
    )),
  });
  await expect(client.chat.cancel("c_x")).rejects.toMatchObject({ name: "ApiError", status: 409, code: "no_active_run" });
});

test("chat.create surfaces non-2xx as ApiError", async () => {
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch(() => new Response(
      JSON.stringify({ error: "bad_request", message: "agent invalid" }),
      { status: 400, headers: { "content-type": "application/json" } },
    )),
  });
  await expect(client.chat.create({ agent: "bogus" })).rejects.toMatchObject({ name: "ApiError", status: 400 });
});

test("chat.stream tolerates run_id and extra fields on data payloads (passthrough)", async () => {
  // SSE bytes containing a frame whose data includes run_id + extra optional fields.
  const sse =
    `event: text\n` +
    `data: ${JSON.stringify({ run_id: "r_1", delta: "hi", extra: "ignored" })}\n` +
    `\n`;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(ctl) {
      ctl.enqueue(enc.encode(sse));
      ctl.close();
    },
  });
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch(() => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })),
  });
  const frames: unknown[] = [];
  for await (const f of client.chat.stream("c_x")) frames.push(f);
  expect(frames.length).toBe(1);
  expect(frames[0]).toMatchObject({ run_id: "r_1", delta: "hi" });
});
