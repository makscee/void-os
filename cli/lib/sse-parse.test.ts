/**
 * Tests for the shared SSE frame parser used by both `cli/ask.ts` and
 * `cli/chat.ts`. Extracted from the inline copies that previously lived
 * in those handlers. The parser preserves the `event:` line (which the
 * protocol client's `sseFrames` drops), so CLI can route `ask_user` /
 * `run_end` correctly.
 */

import { test, expect } from "bun:test";
import { parseSseFrames } from "./sse-parse.ts";
import type { Frame } from "./stream-render.ts";

function makeResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (const c of chunks) ctl.enqueue(enc.encode(c));
      ctl.close();
    },
  });
  return new Response(stream);
}

async function collect(res: Response): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const f of parseSseFrames(res)) out.push(f);
  return out;
}

test("parses well-formed event+data pair", async () => {
  const res = makeResponse([
    'event: text\ndata: {"text":"hi"}\n\n',
  ]);
  const frames = await collect(res);
  expect(frames).toEqual([{ event: "text", data: { text: "hi" } } as Frame]);
});

test("parses multiple frames in one chunk", async () => {
  const res = makeResponse([
    'event: hello\ndata: {"chat_id":"c1"}\n\nevent: text\ndata: {"text":"a"}\n\nevent: run_end\ndata: {}\n\n',
  ]);
  const frames = await collect(res);
  expect(frames.map((f) => f.event)).toEqual(["hello", "text", "run_end"]);
});

test("handles frames split across chunk boundaries", async () => {
  const res = makeResponse([
    "event: text\nda",
    'ta: {"text":"hello"}\n',
    "\n",
  ]);
  const frames = await collect(res);
  expect(frames).toEqual([{ event: "text", data: { text: "hello" } } as Frame]);
});

test("skips malformed JSON data without throwing", async () => {
  const res = makeResponse([
    "event: text\ndata: {not-json}\n\n",
    'event: text\ndata: {"text":"ok"}\n\n',
  ]);
  const frames = await collect(res);
  expect(frames).toEqual([{ event: "text", data: { text: "ok" } } as Frame]);
});

test("skips blocks missing event or data line", async () => {
  const res = makeResponse([
    'data: {"text":"orphan"}\n\n',
    'event: text\ndata: {"text":"good"}\n\n',
  ]);
  const frames = await collect(res);
  expect(frames).toEqual([{ event: "text", data: { text: "good" } } as Frame]);
});

test("returns immediately when response body is null", async () => {
  // Response with no body
  const res = new Response(null);
  const frames = await collect(res);
  expect(frames).toEqual([]);
});

test("preserves event names (not dropped like protocol client's sseFrames)", async () => {
  const res = makeResponse([
    'event: ask_user\ndata: {"tool_use_id":"tu1","prompt":"name?"}\n\n',
  ]);
  const frames = await collect(res);
  expect(frames[0].event).toBe("ask_user");
});
