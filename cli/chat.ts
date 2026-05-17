/**
 * `void-os chat <agent> [--verbose]`
 *
 * Interactive streaming REPL: drives `node:readline`, posts each user input
 * to `POST /chat/:id/message`, opens `GET /chat/:id/stream`, and renders SSE
 * frames live. `ask_user` mid-stream enters a frame-queue gate so readline
 * can prompt for the answer without the renderer racing on stdout.
 *
 * SIGINT during a run cancels the active run via `POST /chat/:id/cancel`
 * and returns to the prompt. A second SIGINT (with no run active) exits 130.
 *
 * SSE is parsed inline (not via `client.chat.stream`) because that helper
 * discards the `event:` line and only yields `data:` payloads — chat needs
 * the event type to route ask_user / run_end correctly.
 */

import { createInterface } from "node:readline";
import { UnreachableError } from "@voidos/protocol";
import { parseArgs } from "./lib/args.ts";
import {
  buildClient,
  NoTokenError,
  resolveBase,
  resolveToken,
} from "./lib/client.ts";
import { createRenderer, type Frame } from "./lib/stream-render.ts";

interface IO {
  stdin?: NodeJS.ReadableStream;
  stdout?: { write(s: string): boolean; isTTY?: boolean };
  stderr?: { write(s: string): boolean; isTTY?: boolean };
}

const USAGE = `usage: void-os chat <agent> [--verbose]

Open an interactive REPL with an agent. Type \`exit\`, \`/exit\`, or send
EOF (Ctrl-D) to close. Ctrl-C cancels the current agent run; a second
Ctrl-C while idle exits with code 130.

flags:
  --verbose   dump raw SSE frames as JSON to stderr alongside rendered output
`;

async function* parseSseFrames(res: Response): AsyncIterable<Frame> {
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

/**
 * Line-pump: an event-driven adapter over readline that lets us request the
 * next line as a Promise. Buffered lines (e.g. when a Readable pushes a full
 * batch before close) survive across consecutive `next()` calls — `rl.question`
 * loses them because it re-pauses the stream between asks. EOF resolves all
 * pending and future calls to `null`.
 */
class LinePump {
  private lines: string[] = [];
  private waiters: Array<(s: string | null) => void> = [];
  private closed = false;

  constructor(
    private rl: ReturnType<typeof createInterface>,
    private stdout: { write(s: string): boolean },
  ) {
    rl.on("line", (l) => {
      if (this.waiters.length > 0) this.waiters.shift()!(l);
      else this.lines.push(l);
    });
    rl.once("close", () => {
      this.closed = true;
      while (this.waiters.length > 0) this.waiters.shift()!(null);
    });
  }

  /** Print prompt text to stdout, then await the next stdin line. */
  next(promptText: string): Promise<string | null> {
    if (promptText) this.stdout.write(promptText);
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close() {
    if (!this.closed) this.rl.close();
  }
}

export default async function chat(args: string[], _opts: { prefix?: string } = {}): Promise<number> {
  const ioFromOpts = (_opts as unknown as IO) ?? {};
  const stdout: IO["stdout"] = ioFromOpts.stdout ?? process.stdout;
  const stderr: IO["stderr"] = ioFromOpts.stderr ?? process.stderr;
  const stdin: NodeJS.ReadableStream = ioFromOpts.stdin ?? process.stdin;

  let parsed;
  try {
    parsed = parseArgs(args, { flags: ["verbose"], values: [] });
  } catch (e) {
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    stderr.write(USAGE);
    return 2;
  }
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.positional.length !== 1) {
    stderr.write(USAGE);
    return 2;
  }
  const agent = parsed.positional[0];
  const verbose = parsed.flags.verbose === true;

  // Build client + probe daemon.
  let client;
  try {
    client = buildClient();
    await client.health();
  } catch (e) {
    if (e instanceof NoTokenError) {
      // Surface the actual NoTokenError message (which points to the
      // missing token + the `void-os daemon start` hint) rather than the
      // generic "daemon not running" fallback — they're distinct failures.
      stderr.write(`${e.message}\n`);
      return 3;
    }
    if (e instanceof UnreachableError) {
      stderr.write("daemon not running; try `void-os daemon start`\n");
      return 3;
    }
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // Validate agent exists.
  try {
    const { agents } = await client.agents.list();
    if (!agents.some((a) => a.name === agent)) {
      stderr.write(`agent '${agent}' not found; run \`void-os agents list\`\n`);
      return 4;
    }
  } catch (e) {
    if (e instanceof UnreachableError) {
      stderr.write("daemon not running; try `void-os daemon start`\n");
      return 3;
    }
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // Create the ephemeral chat.
  let chatId: string;
  try {
    const created = await client.chat.create({ agent });
    chatId = created.id;
  } catch (e) {
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // Capture base/token NOW (env vars may not be touched mid-loop, but lock them in).
  const base = resolveBase();
  const token = resolveToken();

  const rl = createInterface({
    input: stdin,
    output: stdout as unknown as NodeJS.WritableStream,
    terminal: false,
  });
  const pump = new LinePump(rl, stdout);

  const renderer = createRenderer({
    mode: "stream",
    verbose,
    stdout,
    stderr,
  });

  // ask_user gate: while gate=true, incoming SSE frames are queued; on
  // /answer success, the queue is drained through the renderer in arrival
  // order. Prevents readline + renderer races on stdout.
  let gate = false;
  const gateQueue: Frame[] = [];
  const drainGate = () => {
    while (!gate && gateQueue.length > 0) {
      const f = gateQueue.shift()!;
      renderer.handle(f);
    }
  };

  // SIGINT: cancel the active run, else exit 130. The flag flips while a
  // /stream is open and clears on run_end / stream close.
  let runActive = false;
  let sigintExit = false;
  const onSigint = () => {
    if (runActive) {
      // Best-effort cancel; ignore failures (409 = already done).
      client.chat.cancel(chatId).catch(() => {});
    } else {
      sigintExit = true;
      pump.close();
    }
  };
  process.on("SIGINT", onSigint);

  try {
    for (;;) {
      const input = await pump.next("> ");
      if (input === null) {
        return sigintExit ? 130 : 0;
      }
      const trimmed = input.trim();
      if (trimmed === "") continue;
      if (trimmed === "exit" || trimmed === "/exit") return 0;

      // Open the SSE stream BEFORE sending. The daemon's `/chat/:id/stream`
      // handler subscribes to the event bus inside the GET; the orchestrator
      // (driven by POST /message) emits frames synchronously and finishes
      // with `run_end` before send() resolves. If we sent first and
      // subscribed after, frames could fly past an empty bus subscription
      // and we'd hang on a closed stream. Race fix: GET first, then POST.
      const streamUrl = `${base}/chat/${encodeURIComponent(chatId)}/stream`;
      let res: Response;
      try {
        res = await fetch(streamUrl, {
          headers: { authorization: `Bearer ${token}` },
        });
      } catch (e) {
        stderr.write("daemon not running; try `void-os daemon start`\n");
        return 3;
      }
      if (!res.ok || !res.body) {
        stderr.write(`stream failed: ${res.status}\n`);
        continue;
      }

      // Now post the message — bus subscriber is live.
      try {
        await client.chat.send(chatId, trimmed);
      } catch (e) {
        // Close the just-opened stream so the daemon's subscriber is
        // released; we won't iterate it.
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (e instanceof UnreachableError) {
          stderr.write("daemon not running; try `void-os daemon start`\n");
          return 3;
        }
        stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        continue;
      }

      runActive = true;
      try {
        for await (const frame of parseSseFrames(res)) {
          if (gate) {
            gateQueue.push(frame);
            continue;
          }
          if (frame.event === "ask_user") {
            // Enter gate, prompt operator, post answer, drain queue.
            gate = true;
            const data = frame.data as { tool_use_id: string; prompt: string };
            const answer = await pump.next(`agent asks: ${data.prompt}\n> `);
            if (answer === null) {
              // EOF while gated — bail out of the chat entirely.
              return sigintExit ? 130 : 0;
            }
            try {
              await client.chat.answer(chatId, data.tool_use_id, answer);
            } catch (e) {
              stderr.write(
                `failed to send answer: ${e instanceof Error ? e.message : String(e)}\n`,
              );
              // Drop the queue — we can't safely render frames past a failed answer.
              gateQueue.length = 0;
              gate = false;
              break;
            }
            gate = false;
            drainGate();
            continue;
          }
          renderer.handle(frame);
          if (frame.event === "run_end") break;
        }
      } finally {
        runActive = false;
      }
      // Stream closed; loop back for next user input.
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    pump.close();
  }
}
