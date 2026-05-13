import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { honoBridge } from "../src/adapters/mcp/hono-bridge.ts";

describe("honoBridge", () => {
  test("forwards POST body and returns SDK response", async () => {
    const app = new Hono();
    app.all("/mcp", async (c) => {
      const { nodeReq, nodeRes, responsePromise } = honoBridge(c);
      // Simulate what the SDK transport does: read body, write echo back.
      const chunks: Buffer[] = [];
      nodeReq.on("data", (b: Buffer) => chunks.push(b));
      nodeReq.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        nodeRes.statusCode = 200;
        nodeRes.setHeader("content-type", "application/json");
        nodeRes.end(`{"echo":${JSON.stringify(body)}}`);
      });
      return responsePromise;
    });

    const res = await app.fetch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: '{"hello":"world"}' });
  });

  test("streams chunked writes through the response body", async () => {
    const app = new Hono();
    app.all("/mcp", async (c) => {
      const { nodeRes, responsePromise } = honoBridge(c);
      nodeRes.statusCode = 200;
      nodeRes.setHeader("content-type", "text/event-stream");
      nodeRes.write("data: a\n\n");
      nodeRes.write("data: b\n\n");
      nodeRes.end();
      return responsePromise;
    });

    const res = await app.fetch(new Request("http://x/mcp", { method: "POST" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("data: a\n\ndata: b\n\n");
  });
});
