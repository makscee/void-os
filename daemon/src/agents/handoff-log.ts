// VOS-154: handoff-log integration for agent-to-agent dispatch.
//
// Wraps the hub-side `tools/handoff-log/hl` CLI so every `ask_agent` flow
// leaves a provenance entry. The CLI is bash + jq + shasum and is the single
// source of truth for the JSONL schema (see hub/tools/handoff-log/README.md);
// this module is a thin TS adapter, not a reimplementation.
//
// Wiring is best-effort: if VOID_OS_HL_PATH is unset or the binary is missing,
// emitters log a warning and no-op. The daemon must not fail an ask_agent
// dispatch just because the operator's hub log is unreachable (smoke harness
// runs in /tmp where there is no hub clone).
//
// Schema fields (see hl README §"Entry schema"):
//   - kind=dispatch: parent → child, carries bundle hash + expected contract
//   - kind=return:   child → parent, carries return_status + summary
//
// Direction convention (verbatim from hl README):
//   "kind=dispatch: from_agent_id sent a bundle to to_agent_id.
//    kind=return:   from_agent_id is the *child* finishing work;
//                   to_agent_id is the *parent* receiving the report."

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DispatchEntry {
  fromAgentId: string;
  toAgentId: string;
  taskId?: string | null;
  milestone?: string | null;
  session?: string | null;
  bundleText: string;
  expectedContract?: string | null;
  notes?: string | null;
}

export interface ReturnEntry {
  fromAgentId: string;
  toAgentId: string;
  taskId?: string | null;
  milestone?: string | null;
  session?: string | null;
  status: string;
  summary?: string | null;
  bundleText?: string | null;
  durationMs?: number | null;
  parentHandoffId?: string | null;
  notes?: string | null;
}

export interface HandoffLog {
  /** Returns the new entry id (string), or null if the writer is unavailable. */
  dispatch(entry: DispatchEntry): Promise<string | null>;
  /** Returns the new entry id (string), or null if the writer is unavailable. */
  return(entry: ReturnEntry): Promise<string | null>;
}

/** No-op log: every emitter returns null and never throws. Used when the
 *  operator has no hub clone configured (smoke harness, tests). */
export const NULL_HANDOFF_LOG: HandoffLog = {
  async dispatch() {
    return null;
  },
  async return() {
    return null;
  },
};

export interface MakeHandoffLogOpts {
  /** Absolute path to the hl binary. Falsey → NULL_HANDOFF_LOG. */
  hlPath?: string | null;
  /** HUB_ROOT to set when invoking hl (controls log + bundle location).
   *  If unset, hl falls back to its own default (relative to its own dir). */
  hubRoot?: string | null;
  /** Override stderr logger for warnings (tests can capture). */
  warn?: (msg: string) => void;
}

function writeTemp(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vos-hl-"));
  const path = join(dir, "bundle.md");
  writeFileSync(path, text);
  return path;
}

function buildArgs(
  kind: "dispatch" | "return",
  e: DispatchEntry | ReturnEntry,
  bundlePath: string | null,
): string[] {
  const args: string[] = [kind];
  args.push("--from", e.fromAgentId);
  args.push("--to", e.toAgentId);
  args.push("--task", e.taskId ?? "-");
  args.push("--milestone", e.milestone ?? "-");
  args.push("--session", e.session ?? "-");
  if (bundlePath) {
    args.push("--bundle-file", bundlePath);
  }
  if (kind === "dispatch") {
    const d = e as DispatchEntry;
    if (d.expectedContract) {
      args.push("--expected", d.expectedContract);
    }
  } else {
    const r = e as ReturnEntry;
    args.push("--status", r.status);
    if (r.summary != null) args.push("--summary", r.summary);
    if (r.durationMs != null) args.push("--duration-ms", String(r.durationMs));
    if (r.parentHandoffId) args.push("--parent", r.parentHandoffId);
  }
  if (e.notes) args.push("--notes", e.notes);
  return args;
}

function runHl(
  hlPath: string,
  hubRoot: string | null,
  args: string[],
  warn: (msg: string) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (hubRoot) env.HUB_ROOT = hubRoot;
    let stdout = "";
    let stderr = "";
    const child = spawn(hlPath, args, { env });
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    // `child` is typed by @types/bun, whose ChildProcessWithoutNullStreams
    // omits the inherited EventEmitter surface; reach it via EventEmitter
    // (the methods exist at runtime — bun spawns a real Node child) (VOS-167).
    const childEvents = child as unknown as import("node:events").EventEmitter;
    childEvents.on("error", (err: Error) => {
      warn(`hl spawn error: ${err.message}`);
      resolve(null);
    });
    childEvents.on("exit", (code: number | null) => {
      if (code === 0) {
        resolve(stdout.trim() || null);
      } else {
        warn(`hl exit ${code}: ${stderr.trim()}`);
        resolve(null);
      }
    });
  });
}

export function makeHandoffLog(opts: MakeHandoffLogOpts = {}): HandoffLog {
  const hlPath = opts.hlPath ?? null;
  const hubRoot = opts.hubRoot ?? null;
  const warn = opts.warn ?? ((msg: string) => console.warn(`[handoff-log] ${msg}`));

  if (!hlPath) return NULL_HANDOFF_LOG;

  async function run(
    kind: "dispatch" | "return",
    entry: DispatchEntry | ReturnEntry,
    bundleText: string | undefined,
  ): Promise<string | null> {
    let bundlePath: string | null = null;
    if (bundleText !== undefined) {
      try {
        bundlePath = writeTemp(bundleText);
      } catch (err) {
        warn(`bundle tempfile failed: ${(err as Error).message}`);
        return null;
      }
    }
    try {
      const args = buildArgs(kind, entry, bundlePath);
      return await runHl(hlPath!, hubRoot, args, warn);
    } finally {
      if (bundlePath) {
        try {
          unlinkSync(bundlePath);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  return {
    dispatch(entry) {
      return run("dispatch", entry, entry.bundleText);
    },
    return(entry) {
      const text = entry.bundleText ?? undefined;
      return run("return", entry, text);
    },
  };
}

/** Build a handoff log from process env. Used by app.ts wiring:
 *   - VOID_OS_HL_PATH: absolute path to `hl` binary
 *   - VOID_OS_HL_HUB_ROOT: hub root passed to hl as HUB_ROOT
 * Either missing → NULL_HANDOFF_LOG. */
export function makeHandoffLogFromEnv(env: NodeJS.ProcessEnv = process.env): HandoffLog {
  const hlPath = env.VOID_OS_HL_PATH;
  const hubRoot = env.VOID_OS_HL_HUB_ROOT;
  if (!hlPath) return NULL_HANDOFF_LOG;
  return makeHandoffLog({ hlPath, hubRoot });
}
