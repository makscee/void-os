import { test, expect } from "bun:test";
import { fetchAnthropicKey } from "../../src/lib/anthropic-key";

test("env VOID_KEYS_URL set: fetches and returns sk-ant- token", async () => {
  // Stub global fetch
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ key: "sk-ant-test123" }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.VOID_KEYS_URL = "http://stub.local/lease";
    const key = await fetchAnthropicKey();
    expect(key).toBe("sk-ant-test123");
  } finally {
    globalThis.fetch = orig;
    delete process.env.VOID_KEYS_URL;
  }
});

test("VOID_KEYS_URL unset throws descriptive error", async () => {
  delete process.env.VOID_KEYS_URL;
  delete process.env.ANTHROPIC_API_KEY;
  await expect(fetchAnthropicKey()).rejects.toThrow(/VOID_KEYS_URL/);
});

test("falls back to ANTHROPIC_API_KEY env if set", async () => {
  delete process.env.VOID_KEYS_URL;
  process.env.ANTHROPIC_API_KEY = "sk-ant-fallback";
  try {
    expect(await fetchAnthropicKey()).toBe("sk-ant-fallback");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
