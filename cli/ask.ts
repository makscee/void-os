/**
 * `void-os ask <agent> "message" [--stream] [--verbose]`
 *
 * One-shot agent invocation: create a fresh ephemeral chat, send the message,
 * consume the SSE stream until `run_end`, print the response, and exit. An
 * `ask_user` frame mid-run aborts with a "use chat" hint and exit code 6 — the
 * one-shot mode has no way to satisfy a tool's question.
 *
 * Rendering:
 *   - default (buffered): tool one-liners live, text frames buffered until
 *     `run_end` so the user sees one clean answer block.
 *   - --stream:           text frames flushed as received (and tool one-liners).
 *   - --verbose:          raw JSON of every frame mirrored to stderr.
 *
 * On SIGINT / SIGTERM the buffered text is flushed to stdout before exit so we
 * never lose a partial answer.
 *
 * Exit codes follow the VOS-118 spec (`docs/superpowers/specs/.../design.md`):
 *   0 success · 2 usage · 3 daemon offline · 4 agent unknown
 *   5 vault not configured · 6 ask_user during ask · 7 run ended with error
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./lib/args.ts";
import {
  buildClient,
  NoTokenError,
  resolveBase,
  resolveToken,
} from "./lib/client.ts";
import { ApiError, UnreachableError } from "@voidos/protocol";
import { parseSseFrames } from "./lib/sse-parse.ts";
import { createRenderer, type Frame } from "./lib/stream-render.ts";

/*
 * SSE parsing lives in `./lib/sse-parse.ts` (shared with cli/chat.ts).
 *
 * Why we open the stream ourselves (not via `client.chat.stream`):
 *   the protocol client's helper is lazy (fetches on first iteration),
 *   which races the orchestrator — by the time the GET lands, send()
 *   may already have driven the orchestrator to `run_end`. We open the
 *   stream with `fetch()` BEFORE posting the message so the daemon's
 *   `/chat/:id/stream` handler subscribes to the bus synchronously.
 */

const USAGE = `usage: void-os ask <agent> "message" [--stream] [--verbose]

flags:
  --stream    stream text frames as they arrive (default: buffer until run_end)
  --verbose   mirror every raw SSE frame to stderr as JSON
`;

interface IO {
  stdout?: { write(s: string): boolean; isTTY?: boolean };
  stderr?: { write(s: string): boolean; isTTY?: boolean };
}

/**
 * The daemon refuses to start when its vault root is missing (see
 * daemon/src/index.ts:34). There is no runtime HTTP signal for this — it
 * surfaces to us as "daemon unreachable". Probe the FS to disambiguate so
 * we can emit a more actionable error and exit 5 instead of 3.
 */
function vaultMissing(): boolean {
  const root =
    process.env.VOID_OS_VAULT_ROOT ??
    join(homedir(), "Library", "Application Support", "void-os", "vault");
  return !existsSync(root);
}

export default async function ask(args: string[], io: IO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  // --- Parse args -----------------------------------------------------------
  let parsed;
  try {
    parsed = parseArgs(args, {
      flags: ["stream", "verbose"],
      values: [],
    });
  } catch (e) {
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    stderr.write(USAGE);
    return 2;
  }
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.positional.length < 2) {
    stderr.write(USAGE);
    return 2;
  }
  const [agent, ...msgParts] = parsed.positional;
  const message = msgParts.join(" ");
  const streamMode = parsed.flags.stream === true;
  const verbose = parsed.flags.verbose === true;

  // --- Build client ---------------------------------------------------------
  let client;
  try {
    client = buildClient();
  } catch (e) {
    if (e instanceof NoTokenError) {
      stderr.write(`${e.message}\n`);
      return 3;
    }
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // --- Health check (disambiguates daemon-down vs vault-missing) ------------
  try {
    await client.health();
  } catch (e) {
    if (e instanceof UnreachableError) {
      if (vaultMissing()) {
        stderr.write(
          "vault not configured; set VOID_OS_VAULT_ROOT or run: void-os init\n",
        );
        return 5;
      }
      stderr.write("daemon not running; try: void-os daemon start\n");
      return 3;
    }
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // --- Validate agent -------------------------------------------------------
  let agentsResp;
  try {
    agentsResp = await client.agents.list();
  } catch (e) {
    if (e instanceof UnreachableError) {
      stderr.write("daemon not running; try: void-os daemon start\n");
      return 3;
    }
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (!agentsResp.agents.some((a) => a.name === agent)) {
    stderr.write(
      `agent '${agent}' not found; run: void-os agents list\n`,
    );
    return 4;
  }

  // --- Create chat ----------------------------------------------------------
  let chatId: string;
  try {
    const created = await client.chat.create({ agent });
    chatId = created.id; // daemon returns {id, title, created_at}; key is `id`
  } catch (e) {
    if (e instanceof UnreachableError) {
      stderr.write("daemon not running; try: void-os daemon start\n");
      return 3;
    }
    if (e instanceof ApiError && e.status === 404 && e.code === "E_AGENT_NOT_FOUND") {
      stderr.write(`${e.message || `agent '${agent}' not found`}\n`);
      return 4;
    }
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // --- Open SSE stream BEFORE sending --------------------------------------
  // Race fix: the daemon's `/chat/:id/stream` handler subscribes to the
  // event bus inside the GET; the orchestrator's `dispatch` (driven by
  // POST /message) awaits drainRun fully and emits `run_end` before
  // returning. If we sent first and subscribed after, the run could
  // complete (bus emits run_end) before our subscriber existed — we'd
  // hang forever on an empty stream. So: open the GET first, await the
  // Response (subscription is in place), THEN POST the message.
  const base = resolveBase();
  const token = resolveToken();
  const streamUrl = `${base}/chat/${encodeURIComponent(chatId)}/stream`;
  let streamRes: Response;
  try {
    streamRes = await fetch(streamUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    stderr.write("daemon not running; try: void-os daemon start\n");
    return 3;
  }
  if (!streamRes.ok || !streamRes.body) {
    stderr.write(`stream failed: ${streamRes.status}\n`);
    return 1;
  }

  // --- Send message ---------------------------------------------------------
  try {
    await client.chat.send(chatId, message);
  } catch (e) {
    if (e instanceof UnreachableError) {
      stderr.write("daemon not running; try: void-os daemon start\n");
      return 3;
    }
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // --- Stream frames --------------------------------------------------------
  const renderer = createRenderer({
    mode: streamMode ? "stream" : "ask-buffered",
    verbose,
    stdout,
    stderr,
  });

  // Flush partial buffer on abnormal exit so a SIGINT doesn't eat the answer.
  const onSignal = () => renderer.flushBuffer();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    for await (const frame of parseSseFrames(streamRes)) {
      if (!frame || typeof frame !== "object" || !("event" in frame)) continue;

      if (frame.event === "ask_user") {
        // Flush whatever text we have buffered so the user at least sees the
        // partial answer, then emit the fail-fast hint and bail with code 6.
        renderer.flushBuffer();
        stderr.write(
          `agent asked for input; this requires interactive mode. Try: void-os chat ${agent}\n`,
        );
        return 6;
      }
      renderer.handle(frame);
      if (frame.event === "run_end") {
        // VOS-122 F8: respect run terminal status. Daemon emits
        // {status: "ok" | "error", error?: string} on run_end when the
        // orchestrator aborted (tool error, model exception, etc.).
        const data = frame.data as { status?: unknown; error?: unknown };
        if (data.status === "error") {
          const msg =
            (typeof data.error === "string" && data.error) || "run failed";
          stderr.write(`${msg}\n`);
          return 7;
        }
        return 0;
      }
    }
    // Stream closed without an explicit run_end: flush buffered text anyway.
    renderer.flushBuffer();
    return 0;
  } catch (e) {
    if (e instanceof UnreachableError) {
      renderer.flushBuffer();
      stderr.write("daemon not running; try: void-os daemon start\n");
      return 3;
    }
    renderer.flushBuffer();
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}
