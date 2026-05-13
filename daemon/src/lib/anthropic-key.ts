/**
 * Fetch a usable Anthropic auth key (`sk-ant-*`).
 *
 * Resolution order:
 *   1. `ANTHROPIC_API_KEY` env var (fast path / local dev override).
 *   2. `VOID_KEYS_URL` env var — GET that URL, expect JSON `{ key: "sk-ant-..." }`.
 *
 * void-keys is the Anthropic auth-key pool (workspace/void-keys, Bun+Hono+Postgres).
 * It serves real `sk-ant-*` Anthropic keys, not generic API tokens.
 */
export async function fetchAnthropicKey(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const url = process.env.VOID_KEYS_URL;
  if (!url) {
    throw new Error("Missing VOID_KEYS_URL and ANTHROPIC_API_KEY env vars");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`void-keys ${url} returned ${res.status}`);
  const body = (await res.json()) as { key?: string };
  if (!body.key) throw new Error("void-keys response missing 'key' field");
  return body.key;
}
