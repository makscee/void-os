/**
 * Fake Provider — deterministic event-stream replayer for e2e tests.
 *
 * Two extras vs a plain JSONL replayer:
 *   1. `{type:"vos_ask_user", question, options?}` — synthesize an assistant
 *      `tool_use` block for `ask_user`, simultaneously call the daemon's
 *      MCP `/mcp` endpoint over loopback so the pending registry is armed.
 *      Block the script until the daemon resolves the call (i.e. until the
 *      plugin / test POSTs /chat/:id/answer). Inject `${answer}` into any
 *      subsequent assistant text events.
 *   2. `${answer}` substitution in `assistant.message.content[].text` after
 *      a vos_ask_user has resolved.
 */
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Provider,
  ProviderEvent,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../types.ts";
import { TraceWriter } from "../../trace/writer";
import { classifyToolEvents } from "../claude-code/parser.ts";

/**
 * Resolve fake provider script path with per-agent override.
 *
 * Lookup order:
 *   1. `VOS_FAKE_SCRIPT_<agentName>` (per-agent)
 *   2. `VOS_FAKE_SCRIPT` (global)
 *   3. undefined
 */
export function resolveFakeScript(agentName: string): string | undefined {
  const k = `VOS_FAKE_SCRIPT_${agentName}`;
  return process.env[k] ?? process.env.VOS_FAKE_SCRIPT;
}

/**
 * Resolve per-event delay (ms) for the fake provider.
 *
 * Lookup order:
 *   1. `VOS_FAKE_PER_EVENT_DELAY_MS_<agentName>` (per-agent)
 *   2. `VOS_FAKE_PER_EVENT_DELAY_MS` (global)
 *   3. undefined
 *
 * Used by ask_agent E2E so a parent's run does not drain before the
 * test bridge can react to a tool_use frame and call MCP.
 */
export function resolveFakePerEventDelayMs(agentName: string): number | undefined {
  const k = `VOS_FAKE_PER_EVENT_DELAY_MS_${agentName}`;
  const raw = process.env[k] ?? process.env.VOS_FAKE_PER_EVENT_DELAY_MS;
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export interface FakeProviderOpts {
  scriptPath: string;
  /** Optional delay between events. Default 0. Useful for cancel tests. */
  perEventDelayMs?: number;
  /** Daemon's own base URL (e.g. http://127.0.0.1:<port>). Required when the
   *  script uses the `vos_ask_user` directive; otherwise unused. */
  daemonBase?: string;
  /** VOS-84: when set, the fake writes a per-run JSONL trace at
   *  `${tracesDir}/${runId}.jsonl` using TraceWriter, mirroring the
   *  claude-code spawner. Off by default so legacy fake tests that do not
   *  inspect traces remain unaffected. */
  tracesDir?: string;
  /** VOS-84: agent name embedded in `turn.start`. Defaults to "fake". */
  agent?: string;
}

type Substitution = { answer: string } | null;

function substitute(text: string, sub: Substitution): string {
  if (!sub) return text;
  return text.replace(/\$\{answer\}/g, sub.answer);
}

export function makeFakeProvider(opts: FakeProviderOpts): Provider {
  const scriptPath = opts.scriptPath;
  const perEventDelayMs = opts.perEventDelayMs ?? 0;
  return {
    name: "fake",
    spawn(req: ProviderSpawnRequest): ProviderHandle {
      // The fake provider is only spawned in tests; the test rig injects task
      // / context / run identifiers as extra properties on the spawn request
      // (mirroring how production wiring threads them via the orchestrator).
      // ProviderSpawnRequest does not list them, so widen here.
      const reqExt = req as ProviderSpawnRequest & {
        taskId?: string;
        contextId?: string;
      };
      let cancelled = false;
      let resolveDone!: (r: { exitCode?: number; sessionId?: string; reason: "exit" | "cancel" | "timeout" | "error" }) => void;
      const done = new Promise<{ exitCode?: number; sessionId?: string; reason: "exit" | "cancel" | "timeout" | "error" }>((res) => {
        resolveDone = res;
      });
      let sessionId: string | undefined;
      let started = false;
      let substitution: Substitution = null;

      async function callAskUser(
        toolUseId: string,
        question: string,
        options: string[] | undefined,
      ): Promise<string> {
        if (!opts.daemonBase) {
          throw new Error("vos_ask_user directive requires daemonBase opt");
        }
        // Use the same MCP route the production agent would use. We talk
        // JSON-RPC to /mcp with the ask_user tool name; daemon arms pending
        // registry and only returns when /chat/:id/answer resolves it.
        const taskId = reqExt.taskId;
        const contextId = reqExt.contextId ?? taskId;
        const runId = reqExt.runId;
        if (!taskId) {
          throw new Error("vos_ask_user directive requires taskId on spawn request");
        }
        const body = {
          jsonrpc: "2.0" as const,
          id: 1,
          method: "tools/call",
          params: {
            name: "ask_user",
            arguments: {
              question,
              ...(options ? { options } : {}),
              task_id: taskId,
              context_id: contextId,
              ...(runId ? { run_id: runId } : {}),
              // Hand the daemon the same tool_use id we already emitted on
              // the assistant stream so /chat/:id/answer can correlate.
              _vos_tool_use_id: toolUseId,
            },
          },
        };
        const res = await fetch(`${opts.daemonBase}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(`fake ask_user MCP call failed: ${res.status}`);
        }
        // The MCP transport may reply as JSON or as SSE depending on
        // negotiation. Sniff content-type and parse accordingly.
        const ctype = res.headers.get("content-type") ?? "";
        let payload: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
        if (ctype.includes("text/event-stream")) {
          const raw = await res.text();
          // Each SSE record is `event: message\ndata: <json>\n\n`. Take the
          // last `data:` line — the SDK emits the full JSON-RPC reply there.
          const dataLines = raw
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          const last = dataLines[dataLines.length - 1] ?? "{}";
          payload = JSON.parse(last);
        } else {
          payload = (await res.json()) as typeof payload;
        }
        if (payload.error || payload.result?.isError) {
          const txt = payload.result?.content?.[0]?.text ?? JSON.stringify(payload.error ?? payload.result);
          throw new Error(`fake ask_user MCP error: ${txt}`);
        }
        const answer = payload.result?.content?.[0]?.text ?? "";
        return answer;
      }

      async function* gen(): AsyncGenerator<ProviderEvent> {
        started = true;
        // VOS-84: optional JSONL trace. Only opens when tracesDir is set
        // (production wiring path); legacy tests that pass only
        // { scriptPath } keep their no-trace behavior.
        const startedAt = Date.now();
        let trace: TraceWriter | null = null;
        if (opts.tracesDir) {
          mkdirSync(opts.tracesDir, { recursive: true });
          const tracePath = join(opts.tracesDir, `${req.runId}.jsonl`);
          trace = TraceWriter.open(tracePath);
          trace.write("turn.start", {
            runId: req.runId,
            chatId: req.chatId ?? null,
            agent: opts.agent ?? "fake",
            kind: req.kind ?? "chat",
            userMessage: req.prompt,
          });
        }
        const closeTrace = (status: "ok" | "failed" | "cancelled" | "error", exitCode: number | null) => {
          if (!trace) return;
          trace.write("turn.end", { status, durationMs: Date.now() - startedAt, exitCode });
          trace.close();
          trace = null;
        };
        let raw: string;
        try {
          raw = await readFile(scriptPath, "utf8");
        } catch {
          closeTrace("error", null);
          resolveDone({ reason: "error" });
          return;
        }
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          if (cancelled) { closeTrace("cancelled", null); resolveDone({ reason: "cancel" }); return; }
          let parsed: unknown;
          try { parsed = JSON.parse(line); }
          catch { closeTrace("error", null); resolveDone({ reason: "error" }); return; }
          const obj = parsed as { type?: unknown } & Record<string, unknown>;
          if (obj.type === "vos_ask_user") {
            // Synthesize an assistant tool_use block so the orchestrator
            // emits chat.tool_use to the plugin. We do NOT mint a separate
            // tool_use id for the synthesized assistant event vs the MCP
            // call: callAskUser passes the same id through to the daemon as
            // a `_vos_tool_use_id` hint so the answer route's correlation
            // works against the same id the plugin observed.
            const toolUseId = `ask_${randomUUID()}`;
            const question = String(obj.question ?? "");
            const options = Array.isArray(obj.options)
              ? (obj.options as string[])
              : undefined;
            const askEvent: ProviderEvent = {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: toolUseId,
                    name: "ask_user",
                    input: { question, ...(options ? { options } : {}) },
                  },
                ],
              },
            };
            // Kick the MCP call BEFORE yielding the tool_use, so the
            // daemon's pending registry is armed by the time the consumer
            // sees the event and POSTs to /chat/:id/answer.
            const answerPromise = callAskUser(toolUseId, question, options);
            // VOS-84: mirror synthesized tool_use into the trace as
            // cc.event + classified tool.call envelopes.
            if (trace) {
              trace.write("cc.event", askEvent);
              for (const cls of classifyToolEvents(askEvent)) {
                if (cls.kind === "tool.call") {
                  trace.write("tool.call", { toolUseId: cls.toolUseId, name: cls.name, input: cls.input });
                } else {
                  trace.write("tool.result", { toolUseId: cls.toolUseId, content: cls.content, isError: cls.isError });
                }
              }
            }
            yield askEvent;
            // Now wait for the answer to flow back via /chat/:id/answer.
            try {
              substitution = { answer: await answerPromise };
            } catch {
              closeTrace("error", null);
              resolveDone({ reason: "error" });
              return;
            }
            continue;
          }
          // Standard ProviderEvent line.
          const ev = parsed as ProviderEvent;
          if (ev.type === "system" && typeof (ev as { session_id?: string }).session_id === "string") {
            sessionId = (ev as { session_id: string }).session_id;
          }
          // ${answer} substitution for assistant text events.
          if (ev.type === "assistant" && substitution) {
            const m = (ev as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
            if (m?.content) {
              m.content = m.content.map((c) =>
                c && c.type === "text" && typeof c.text === "string"
                  ? { ...c, text: substitute(c.text, substitution) }
                  : c,
              );
            }
          }
          // VOS-84: mirror standard scripted events into the trace.
          if (trace) {
            trace.write("cc.event", ev);
            for (const cls of classifyToolEvents(ev)) {
              if (cls.kind === "tool.call") {
                trace.write("tool.call", { toolUseId: cls.toolUseId, name: cls.name, input: cls.input });
              } else {
                trace.write("tool.result", { toolUseId: cls.toolUseId, content: cls.content, isError: cls.isError });
              }
            }
            // Opt-in stderr emission: script lines may set `_stderr` to a
            // string chunk to drive cc.stderr envelopes.
            const stderrChunk = (obj as { _stderr?: unknown })._stderr;
            if (typeof stderrChunk === "string" && stderrChunk.length > 0) {
              trace.write("cc.stderr", { chunk: stderrChunk });
            }
          }
          yield ev;
          if (perEventDelayMs > 0) await new Promise((r) => setTimeout(r, perEventDelayMs));
        }
        closeTrace("ok", 0);
        resolveDone({ reason: "exit", exitCode: 0, sessionId });
      }

      return {
        events: gen(),
        async cancel() {
          if (cancelled) return false;
          cancelled = true;
          if (!started) resolveDone({ reason: "cancel" });
          return true;
        },
        done,
      };
    },
  };
}
