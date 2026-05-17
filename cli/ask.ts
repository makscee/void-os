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
 *   5 vault not configured · 6 ask_user during ask
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./lib/args.ts";
import { buildClient, NoTokenError } from "./lib/client.ts";
import { UnreachableError } from "@voidos/protocol";
import { createRenderer, type Frame } from "./lib/stream-render.ts";

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

  // --- Create chat + send message ------------------------------------------
  let chatId: string;
  try {
    const created = await client.chat.create({ agent });
    chatId = created.id; // daemon returns {id, title, created_at}; key is `id`
  } catch (e) {
    if (e instanceof UnreachableError) {
      stderr.write("daemon not running; try: void-os daemon start\n");
      return 3;
    }
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
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
    for await (const raw of client.chat.stream(chatId)) {
      // The protocol client yields the parsed JSON payload from each `data:`
      // line. Daemon embeds the frame envelope as `{event, data}` so we use
      // it directly as our Frame type after a shape check.
      const frame = raw as Frame;
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
