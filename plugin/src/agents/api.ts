// VOS-92 T3.3: HTTP shim for GET /agents. Mirrors makeChatApi factory.
//
// Construction: makeAgentsApi(baseUrl, fetchImpl)
// - fetchImpl is the requestUrlAsFetch shim from main.ts (Obsidian CORS bypass).
// - Pure function: deterministic given the fetch seam, easy to test.
//
// Reuses ApiError + jsonOrThrow from ../chat/api to avoid duplication.

import { ApiError, jsonOrThrow } from "../chat/api";
import type { AgentListEntry } from "./types";

export interface AgentsApi {
  listAgents(): Promise<AgentListEntry[]>;
}

export function makeAgentsApi(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): AgentsApi {
  return {
    async listAgents() {
      const res = await fetchImpl(`${baseUrl}/agents`, { method: "GET" });
      const body = (await jsonOrThrow(res)) as { agents?: AgentListEntry[] };
      return body?.agents ?? [];
    },
  };
}

// Re-export ApiError so callers can `import { ApiError } from "./agents/api"`
// if they want a single import surface. (Tests import directly from chat/api.)
export { ApiError };
