#!/usr/bin/env bun
// VOS-106 T3: PreToolUse hook script. Spawned by CC per tool call.
// Reads CC's tool-call payload on stdin; reads scopes from env; prints
// {continue: bool, stopReason?: string} on stdout. Always exit 0 — CC
// reads the decision from stdout, not from exit code.

import * as path from "node:path";
import { matchPath } from "../../../permissions/match";
import {
  parseShellPaths,
  SHELL_META_SENTINEL,
  SHELL_SUBSTITUTION_SENTINEL,
} from "./parse-shell-paths";

interface ToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
}
interface Decision {
  continue: boolean;
  stopReason?: string;
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function resolveAbs(p: string, cwd: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
}

function emit(decision: Decision): never {
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

function gateRead(paths: string[], cwd: string, reads: readonly string[]): Decision {
  for (const p of paths) {
    const abs = resolveAbs(p, cwd);
    if (!matchPath(abs, reads)) {
      return {
        continue: false,
        stopReason: `READ_SCOPE_DENIED: ${p} outside read_scope`,
      };
    }
  }
  return { continue: true };
}

function gateWrite(
  paths: string[],
  cwd: string,
  writes: readonly string[],
  systemDeny: readonly string[],
): Decision {
  for (const p of paths) {
    const abs = resolveAbs(p, cwd);
    if (matchPath(abs, systemDeny)) {
      return { continue: false, stopReason: `SYSTEM_DENY: ${p}` };
    }
    if (!matchPath(abs, writes)) {
      return {
        continue: false,
        stopReason: `WRITE_SCOPE_DENIED: ${p} outside write_scope`,
      };
    }
  }
  return { continue: true };
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of Bun.stdin.stream()) {
    data += new TextDecoder().decode(chunk);
  }
  return data;
}

const raw = await readStdin();
let call: ToolCall;
try {
  call = JSON.parse(raw) as ToolCall;
} catch {
  // Bad input is the daemon's bug, not the agent's — fail closed.
  emit({ continue: false, stopReason: "HOOK_BAD_INPUT" });
}

const cwd = process.env.VOS_VAULT_ROOT ?? process.cwd();
const reads = envList("VOS_READ_PATHS");
const writes = envList("VOS_WRITE_PATHS");
const systemDeny = envList("VOS_SYSTEM_DENY");

const tool = call!.tool_name;
const args = call!.tool_input ?? {};

if (WRITE_TOOLS.has(tool)) {
  const paths: string[] = [];
  if (typeof args.file_path === "string") paths.push(args.file_path);
  if (Array.isArray((args as { edits?: unknown }).edits)) {
    // MultiEdit: edits[].file_path — but in practice MultiEdit uses
    // a single file_path at the top level. Defensive: also collect
    // any nested file_path.
    for (const e of (args as { edits: Array<Record<string, unknown>> }).edits) {
      if (typeof e.file_path === "string") paths.push(e.file_path);
    }
  }
  emit(gateWrite(paths, cwd, writes, systemDeny));
}

if (READ_TOOLS.has(tool)) {
  const paths: string[] = [];
  if (typeof args.file_path === "string") paths.push(args.file_path);
  else if (typeof args.pattern === "string") paths.push(args.pattern);
  else if (typeof args.path === "string") paths.push(args.path);
  emit(gateRead(paths, cwd, reads));
}

if (tool === "Bash") {
  const command = typeof args.command === "string" ? args.command : "";
  const { reads: rdPaths, writes: wrPaths } = parseShellPaths(command);
  // Shell substitution / parameter expansion poisons literal-token analysis.
  // parseShellPaths emits SHELL_SUBSTITUTION_SENTINEL in reads when detected;
  // force deny here rather than letting matchPath evaluate the resolved path,
  // since under a sufficiently broad scope a literal sentinel under cwd could
  // otherwise match a `**` glob.
  if (rdPaths.includes(SHELL_SUBSTITUTION_SENTINEL) || wrPaths.includes(SHELL_SUBSTITUTION_SENTINEL)) {
    emit({ continue: false, stopReason: "BASH_SHELL_SUBSTITUTION: unanalyzable command" });
  }
  // VOS-106 T11.1: meta-token sentinel (pipes, chains, stderr redirects).
  // Same fail-closed treatment as shell substitution — literal-token analysis
  // can't see verbs hiding behind `|`/`;`/`&&`/`2>`/`<`, so deny outright.
  if (rdPaths.includes(SHELL_META_SENTINEL) || wrPaths.includes(SHELL_META_SENTINEL)) {
    emit({ continue: false, stopReason: "BASH_SHELL_META: chain/pipe/redirect unanalyzable" });
  }
  if (wrPaths.length > 0) {
    const dec = gateWrite(wrPaths, cwd, writes, systemDeny);
    if (!dec.continue) emit(dec);
  }
  if (rdPaths.length > 0) {
    const dec = gateRead(rdPaths, cwd, reads);
    if (!dec.continue) emit(dec);
  }
  emit({ continue: true });
}

emit({ continue: true });
