// VOS-92 T3.2: makeAgentsApi.listAgents() GETs /agents and parses
// the { agents: [...] } envelope. Mirrors chat-api.test.ts style.

import { describe, expect, test } from "bun:test";
import { makeAgentsApi } from "../src/agents/api";
import { ApiError } from "../src/chat/api";

function fakeFetch(
  routes: Record<string, { status: number; body: unknown }>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = Object.entries(routes).find(([k]) => url.endsWith(k));
    if (!route) throw new Error(`fakeFetch: no route for ${url}`);
    const { status, body } = route[1];
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
}

describe("makeAgentsApi", () => {
  test("listAgents GETs /agents and unwraps {agents: [...]}", async () => {
    const api = makeAgentsApi("http://test", fakeFetch({
      "/agents": {
        status: 200,
        body: { agents: [
          { name: "maya", description: "front desk" },
          { name: "journaler", description: "writes" },
        ] },
      },
    }));
    const rows = await api.listAgents();
    expect(rows).toEqual([
      { name: "maya", description: "front desk" },
      { name: "journaler", description: "writes" },
    ]);
  });

  test("non-200 throws ApiError", async () => {
    const api = makeAgentsApi("http://test", fakeFetch({
      "/agents": { status: 500, body: { error: "boom" } },
    }));
    await expect(api.listAgents()).rejects.toBeInstanceOf(ApiError);
  });

  test("missing `agents` key → []", async () => {
    const api = makeAgentsApi("http://test", fakeFetch({
      "/agents": { status: 200, body: {} },
    }));
    expect(await api.listAgents()).toEqual([]);
  });
});
