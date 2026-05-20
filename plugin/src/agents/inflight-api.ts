// VOS-160: HTTP shim for GET /agents/inflight (snapshot mode).
//
// Construction: makeInflightApi(baseUrl, getToken, fetchImpl)
//   - getToken() resolves the daemon bearer token on every call so token
//     rotation between daemon restarts is picked up without a reload.
//   - fetchImpl is the requestUrlAsFetch shim from main.ts (Obsidian
//     CORS bypass) — the renderer's native fetch is CORS-gated and the
//     daemon emits no Access-Control-Allow-Origin header.
//
// Why poll the snapshot rather than the ?stream=1 SSE channel:
//   the SSE channel is auth-gated and only consumable via EventSource or
//   a streaming fetch. EventSource cannot attach a bearer header (and
//   would send a forbidden Origin), and a streaming fetch from the
//   Obsidian renderer is CORS-preflighted → 403. The snapshot endpoint
//   over requestUrl (out-of-process, CORS-free) is the only viable path.
//   The snapshot already carries a bounded per-agent `trace`, so polling
//   it at <=2s satisfies the inspector's "step-by-step trace" need
//   without any streaming wire.

import { ApiError } from "../chat/api";
import type { InflightAgent } from "./inflight-types";

/** VOS-161: the inspector intervention verbs. */
export type AgentVerb = "pause" | "resume" | "kill";

export interface VerbResult {
  agent_id: string;
  control_state: "running" | "paused" | "killed";
}

export interface InflightApi {
  /** Fetch the current in-flight agent snapshot. Throws ApiError on a
   *  non-2xx response; throws a plain Error if the token is unavailable. */
  getInflight(): Promise<InflightAgent[]>;
  /** VOS-161: drive a pause/resume/kill verb against an agent. Throws
   *  ApiError on a non-2xx response (404 = unknown / already-terminal
   *  agent); throws a plain Error if the token is unavailable. */
  postVerb(agentId: string, verb: AgentVerb): Promise<VerbResult>;
}

export function makeInflightApi(
  baseUrl: string,
  getToken: () => string | null,
  fetchImpl: typeof fetch = fetch,
): InflightApi {
  return {
    async getInflight() {
      const token = getToken();
      if (!token) {
        // No token on disk → daemon not booted (or pre-token-write race).
        // Surface as a typed-ish error the view treats as "offline".
        throw new ApiError(0, null, "daemon token unavailable");
      }
      const res = await fetchImpl(`${baseUrl}/agents/inflight`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let body: unknown = null;
        try { body = await res.json(); } catch { /* no body */ }
        throw new ApiError(res.status, body);
      }
      const parsed = (await res.json()) as { agents?: InflightAgent[] };
      return Array.isArray(parsed?.agents) ? parsed.agents : [];
    },

    async postVerb(agentId, verb) {
      const token = getToken();
      if (!token) {
        throw new ApiError(0, null, "daemon token unavailable");
      }
      const res = await fetchImpl(
        `${baseUrl}/agents/${encodeURIComponent(agentId)}/${verb}`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        let body: unknown = null;
        try { body = await res.json(); } catch { /* no body */ }
        throw new ApiError(res.status, body);
      }
      return (await res.json()) as VerbResult;
    },
  };
}

export { ApiError };
