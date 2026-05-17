/**
 * Shared SSE frame parser for `cli/ask.ts` and `cli/chat.ts`.
 *
 * Reads a `Response.body` and yields `{event, data}` frames matching the
 * daemon's wire shape: `event: <name>\ndata: <json>\n\n`. Both `event:`
 * and `data:` lines are required — blocks missing either are skipped.
 *
 * Why this isn't `protocol/src/client.ts`'s `sseFrames`: that helper
 * discards the `event:` line and only yields data payloads. CLI needs
 * the event type to route `ask_user` / `run_end` correctly, so we keep
 * a separate parser here.
 */

import type { Frame } from "./stream-render.ts";

export async function* parseSseFrames(res: Response): AsyncIterable<Frame> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let ev: string | undefined;
      let data: string | undefined;
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (!ev || !data) continue;
      try {
        yield { event: ev, data: JSON.parse(data) } as Frame;
      } catch {
        // skip malformed JSON
      }
    }
  }
}
