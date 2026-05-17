/**
 * SSE frame → terminal output renderer for `void-os ask` and `void-os chat`.
 *
 * Two modes:
 *   - "stream":        text frames flush to stdout as received.
 *   - "ask-buffered":  text frames accumulate; flushed once on `run_end`
 *                      (or via `flushBuffer()` on abnormal termination).
 *
 * Tool calls always render live as one-liners (· name args / ↳ ok | error).
 * `verbose: true` additionally dumps each raw frame as JSON to stderr.
 *
 * ANSI escapes are emitted only when `opts.stdout.isTTY === true` so piped
 * output stays plain. The renderer never reads from `process` — all I/O is
 * injected by the caller, which keeps it testable and reusable.
 *
 * Frame `data` payloads may carry an extra `run_id` field (the daemon
 * attaches one to every SSE event). The renderer ignores fields it does
 * not need; passing unknown extras is safe.
 */

import { ansi, useColor } from "./tty";

export type Frame =
  | { event: "hello"; data: Record<string, unknown> }
  | { event: "text"; data: { text: string; run_id?: string } }
  | {
      event: "tool_use";
      data: {
        name: string;
        input: Record<string, unknown>;
        run_id?: string;
      };
    }
  | {
      event: "tool_result";
      data: {
        ok: boolean;
        size?: number;
        error?: string;
        run_id?: string;
      };
    }
  | {
      event: "ask_user";
      data: { tool_use_id: string; prompt: string; run_id?: string };
    }
  | { event: "usage"; data: Record<string, unknown> }
  | { event: "run_end"; data: Record<string, unknown> }
  | { event: "error"; data: { message: string; run_id?: string } };

export type Mode = "stream" | "ask-buffered";

export interface WriteStreamLike {
  write(s: string): boolean;
  isTTY?: boolean;
}

export interface RendererOpts {
  mode: Mode;
  verbose?: boolean;
  stdout: WriteStreamLike;
  stderr: WriteStreamLike;
}

export interface Renderer {
  handle(frame: Frame): void;
  /** Flush any buffered text (used on abnormal termination / SIGINT). */
  flushBuffer(): void;
}

/**
 * Pull the first scalar (string|number|boolean) value out of the tool's
 * input dict for a compact one-liner summary. Long values are truncated.
 */
function firstScalarArg(input: Record<string, unknown>): string {
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      return s.length > 60 ? `${s.slice(0, 57)}...` : s;
    }
  }
  return "";
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function createRenderer(opts: RendererOpts): Renderer {
  const colorOut = ansi(useColor(opts.stdout));
  const buffer: string[] = [];

  const writeText = (s: string) => {
    if (opts.mode === "stream") opts.stdout.write(s);
    else buffer.push(s);
  };

  const flushBuffer = () => {
    if (buffer.length > 0) {
      opts.stdout.write(buffer.join("") + "\n");
      buffer.length = 0;
    }
  };

  return {
    handle(frame) {
      if (opts.verbose) opts.stderr.write(`${JSON.stringify(frame)}\n`);
      switch (frame.event) {
        case "text":
          writeText(frame.data.text);
          return;
        case "tool_use": {
          const summary = firstScalarArg(frame.data.input);
          const line = `· ${frame.data.name}${summary ? " " + summary : ""}`;
          opts.stdout.write(colorOut.dim(line) + "\n");
          return;
        }
        case "tool_result": {
          if (frame.data.ok) {
            const sz =
              typeof frame.data.size === "number" ? ` (${fmtSize(frame.data.size)})` : "";
            opts.stdout.write(colorOut.dim(`  ↳ ok${sz}`) + "\n");
          } else {
            opts.stdout.write(
              colorOut.red(`  ↳ error: ${frame.data.error ?? "unknown"}`) + "\n",
            );
          }
          return;
        }
        case "run_end":
          flushBuffer();
          return;
        case "ask_user":
        case "hello":
        case "usage":
        case "error":
          // T6 (chat) handles ask_user; ask handler short-circuits before
          // reaching the renderer. hello/usage/error are no-ops here.
          return;
      }
    },
    flushBuffer,
  };
}
