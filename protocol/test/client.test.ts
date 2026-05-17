import { test, expect } from "bun:test";
import { makeClient, ApiError, ServerError, UnreachableError } from "../src/client.ts";

function fakeFetch(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return Promise.resolve(handler(req));
  };
}

test("health() sends bearer + parses HealthResp", async () => {
  let seen: Request | null = null;
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch((req) => {
      seen = req;
      return new Response(
        JSON.stringify({ ok: true, version: "0.0.1", vault_root: "/v", uptime_s: 1, sessions: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  });
  const h = await client.health();
  expect(h.version).toBe("0.0.1");
  expect(seen!.headers.get("authorization")).toBe("Bearer tok");
  expect(new URL(seen!.url).pathname).toBe("/health");
});

test("agents.list() returns parsed list", async () => {
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: fakeFetch(() => new Response(JSON.stringify({ agents: [{ name: "maya", description: "d" }] }), { status: 200, headers: { "content-type": "application/json" } })),
  });
  const r = await client.agents.list();
  expect(r.agents.length).toBe(1);
});

test("vault.write() sends JSON body", async () => {
  let body: any = null;
  let ct: string | null = null;
  let method: string | null = null;
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: fakeFetch(async (req) => {
      method = req.method;
      ct = req.headers.get("content-type");
      body = await req.json();
      return new Response(JSON.stringify({ path: "p", size: 5, mtime: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  });
  const r = await client.vault.write("notes.md", "hello");
  expect(method).toBe("PUT");
  expect(ct).toContain("application/json");
  expect(body).toEqual({ content: "hello" });
  expect(r.size).toBe(5);
});

test("4xx throws ApiError with code + status", async () => {
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: fakeFetch(() => new Response(JSON.stringify({ error: "E_NOT_FOUND", message: "missing" }), { status: 404, headers: { "content-type": "application/json" } })),
  });
  await expect(client.vault.read("nope")).rejects.toMatchObject({ name: "ApiError", status: 404, code: "E_NOT_FOUND" });
});

test("5xx throws ServerError", async () => {
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: fakeFetch(() => new Response("boom", { status: 500 })),
  });
  await expect(client.health()).rejects.toMatchObject({ name: "ServerError", status: 500 });
});

test("network failure throws UnreachableError", async () => {
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: () => Promise.reject(new TypeError("fetch failed")),
  });
  await expect(client.health()).rejects.toMatchObject({ name: "UnreachableError" });
});

test("ApiError, ServerError, UnreachableError are distinct classes", () => {
  expect(new ApiError("E_X", "m", 400)).toBeInstanceOf(ApiError);
  expect(new ServerError(500, "x")).toBeInstanceOf(ServerError);
  expect(new UnreachableError(new Error("e"))).toBeInstanceOf(UnreachableError);
});
