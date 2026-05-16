# VOS-106 Loader Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire agent-scope enforcement and MCP allowlist into every CC subprocess spawn so spawned agents can only Read/Write what their `agent.md` permits, and so `ask_agent` / `vault.read` become reachable from real CC runs for the first time.

**Architecture:** Per-spawn `settings.json` + `mcp.json` files written to the trace dir, fed to CC via `--settings` / `--mcp-config`. A single PreToolUse hook script (`pre-tool-use.ts`) consumes env-encoded scopes (`VOS_READ_PATHS`, `VOS_WRITE_PATHS`) and shares a `matchPath` module with the daemon-side `PermissionEngine`. MCP server resolves the calling-agent identity from URL query (`?agent=<name>&run=<runId>`) and gates `vault.read` via `engine.canRead`. Six-probe e2e harness against a fixed fixture vault verifies cross-agent routing.

**Tech Stack:** Bun + TypeScript, `picomatch` 4.x, `@modelcontextprotocol/sdk` 1.20.0, Hono, sqlite (`bun:sqlite`), `claudev claude` (Claude Code CLI via the claudev wrapper).

**Spec:** `docs/superpowers/specs/2026-05-16-vos-106-loader-integration-design.md`

**Repo paths:** All paths in this plan are relative to the void-os workspace root (`workspace/void-os/` in hub, equivalently the repo root when working inside the worktree at `~/hub-wt/VOS-106/workspace/void-os/`). Commits land on `task/VOS-106` inside the worktree; the orchestrator handles push later.

---

## Task 0: Hook-error fail-mode spike + pin CC version

**Why this is T0:** Spec §4 + §7 mandate verifying that CC's PreToolUse fails-closed (denies tool call) when the hook script errors. If CC fails-open in the pinned version, every subsequent task is built on a foundation that silently disables all scope enforcement. Must verify before writing one line of T1+.

**Files:**
- Create: `daemon/test/spikes/vos-106-hook-fail-mode.ts` (throwaway spike script, kept in repo for re-run on CC upgrades)
- Modify: `daemon/package.json` — add `claudev` + `claude` version pin under a new `voidos` block
- Create: `daemon/test/spikes/README.md`

- [ ] **Step 1: Capture pinned CC version**

Run:
```bash
claudev claude --version
```
Expected: a line like `2.0.20 (Claude Code)`. Record the version string.

- [ ] **Step 2: Write the spike script**

Create `daemon/test/spikes/vos-106-hook-fail-mode.ts`:

```ts
// VOS-106 T0: verify CC's PreToolUse hook-error fail-mode.
//
// Spawns `claudev claude -p '<prompt>' --settings <broken-hook.json>` and
// asks CC to call Edit on a path. The hook script is deliberately broken
// (exits 1 with no stdout). We assert CC denies the tool call.
//
// Run: bun run daemon/test/spikes/vos-106-hook-fail-mode.ts
// Exit 0 = fail-closed (good). Exit 1 = fail-open (BAD — design must change).

import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "vos-106-spike-"));
const brokenHook = join(dir, "broken.sh");
const settingsPath = join(dir, "settings.json");

writeFileSync(brokenHook, "#!/bin/sh\nexit 1\n");
chmodSync(brokenHook, 0o755);

writeFileSync(
  settingsPath,
  JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [{ type: "command", command: brokenHook }],
        },
      ],
    },
  }),
);

const probeFile = join(dir, "probe.txt");
writeFileSync(probeFile, "before\n");

const prompt =
  `Use the Edit tool to change the word "before" to "after" in the file ${probeFile}. ` +
  `Then say "DONE" or "BLOCKED" depending on whether the edit succeeded.`;

const proc = Bun.spawn(
  [
    "claudev",
    "claude",
    "-p",
    prompt,
    "--settings",
    settingsPath,
    "--output-format",
    "stream-json",
    "--verbose",
  ],
  { stdout: "pipe", stderr: "pipe" },
);

const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
await proc.exited;

const finalContent = await Bun.file(probeFile).text();

console.log("--- stdout (last 40 lines) ---");
console.log(out.split("\n").slice(-40).join("\n"));
console.log("--- stderr (last 20 lines) ---");
console.log(err.split("\n").slice(-20).join("\n"));
console.log("--- probe file final content ---");
console.log(JSON.stringify(finalContent));

if (finalContent === "before\n") {
  console.log("VERDICT: fail-closed (Edit denied, file unchanged). GOOD.");
  process.exit(0);
}
console.log("VERDICT: fail-open (Edit ran despite broken hook). BAD — design must change.");
process.exit(1);
```

- [ ] **Step 3: Run the spike**

Run:
```bash
cd workspace/void-os && bun run daemon/test/spikes/vos-106-hook-fail-mode.ts
```
Expected: VERDICT line ends in `GOOD.` and exit code 0. If `BAD.`, STOP — re-design with daemon-side enforcement before continuing (raise with user; do not proceed to T1).

- [ ] **Step 4: Pin the verified version**

Edit `daemon/package.json`. Add a new top-level `voidos` block (after `dependencies`):

```json
  "voidos": {
    "claudeCodeVersion": "<version from Step 1>",
    "claudevVersion": "<run `claudev --version` and paste>",
    "preToolUseFailMode": "fail-closed (verified VOS-106 T0)"
  }
```

- [ ] **Step 5: Spike README**

Create `daemon/test/spikes/README.md`:

```markdown
# daemon/test/spikes

One-off verification scripts kept in-repo so we can re-run them on
upstream-binary upgrades. Not part of `bun test`.

## vos-106-hook-fail-mode.ts

Verifies CC's PreToolUse hook fails-closed when the hook script errors.
Re-run whenever `daemon/package.json` `voidos.claudeCodeVersion` is bumped:

    bun run daemon/test/spikes/vos-106-hook-fail-mode.ts

Exit 0 = fail-closed (design holds). Exit 1 = fail-open (design must change).
```

- [ ] **Step 6: Commit**

```bash
git add daemon/test/spikes/ daemon/package.json
git commit -m "task(VOS-106): T0 hook-error fail-mode spike + pin CC version"
```

---

## Task 1: Shared matcher module

**Files:**
- Create: `daemon/src/permissions/match.ts`
- Test: `daemon/src/permissions/__tests__/match.test.ts`
- Modify: `daemon/src/permissions/engine.ts` (replace inline `compileScope` body with `matchPath`)

- [ ] **Step 1: Write the failing test**

Create `daemon/src/permissions/__tests__/match.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { matchPath } from "../match";

describe("matchPath", () => {
  it("matches exact glob", () => {
    expect(matchPath("/v/journal/2026-05-16.md", ["/v/journal/**"])).toBe(true);
  });
  it("rejects outside scope", () => {
    expect(matchPath("/v/work/tasks/active/X.md", ["/v/journal/**"])).toBe(false);
  });
  it("matches multi-pattern OR", () => {
    expect(
      matchPath("/v/work/active/X.md", ["/v/journal/**", "/v/work/**"]),
    ).toBe(true);
  });
  it("rejects empty pattern list", () => {
    expect(matchPath("/v/journal/X.md", [])).toBe(false);
  });
  it("treats trailing-slash dir like its contents glob", () => {
    expect(matchPath("/v/journal/X.md", ["/v/journal/**"])).toBe(true);
  });
  it("requires absolute input path", () => {
    expect(() => matchPath("relative/path", ["/v/**"])).toThrow(
      /absolute/i,
    );
  });
  it("normalizes .. segments before matching", () => {
    expect(matchPath("/v/journal/../journal/X.md", ["/v/journal/**"])).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test daemon/src/permissions/__tests__/match.test.ts`
Expected: FAIL — `Cannot find module '../match'`.

- [ ] **Step 3: Write `match.ts`**

Create `daemon/src/permissions/match.ts`:

```ts
// VOS-106: shared path-matching primitive consumed by both the
// in-daemon PermissionEngine and the standalone PreToolUse hook script
// (daemon/src/providers/claude-code/hook-bin/pre-tool-use.ts). Single
// source of truth for glob semantics + path normalization so the two
// enforcement entry points cannot drift.

import * as path from "node:path";
import picomatch from "picomatch";

const PICOMATCH_OPTS: picomatch.PicomatchOptions = { dot: true, nocase: false };

export function matchPath(absPath: string, patterns: readonly string[]): boolean {
  if (!path.isAbsolute(absPath)) {
    throw new TypeError(`matchPath: absPath must be absolute, got ${JSON.stringify(absPath)}`);
  }
  if (patterns.length === 0) return false;
  const normalized = path.resolve(absPath);
  return patterns.some((pat) => picomatch(pat, PICOMATCH_OPTS)(normalized));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test daemon/src/permissions/__tests__/match.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Refactor `engine.ts` to consume `matchPath`**

In `daemon/src/permissions/engine.ts`, replace the existing `compileScope` body (around lines 144-148):

```ts
  function compileScope(paths: string[]): (p: string) => boolean {
    if (paths.length === 0) return () => false;
    const matchers = paths.map((p) => picomatch(p, PICOMATCH_OPTS));
    return (p: string) => matchers.some((m) => m(p));
  }
```

with:

```ts
  function compileScope(paths: string[]): (p: string) => boolean {
    return (p: string) => matchPath(p, paths);
  }
```

Add the import near the top (next to the existing `import picomatch from 'picomatch';`):

```ts
import { matchPath } from './match';
```

- [ ] **Step 6: Verify existing engine tests still pass**

Run: `cd workspace/void-os && bun test daemon/src/permissions/`
Expected: ALL engine tests + new match tests PASS.

- [ ] **Step 7: Commit**

```bash
git add daemon/src/permissions/match.ts daemon/src/permissions/__tests__/match.test.ts daemon/src/permissions/engine.ts
git commit -m "task(VOS-106): T1 shared matchPath module + engine.ts consumes it"
```

---

## Task 2: Shell-arg classifier

**Files:**
- Create: `daemon/src/providers/claude-code/hook-bin/parse-shell-paths.ts`
- Test: `daemon/src/providers/claude-code/hook-bin/__tests__/parse-shell-paths.test.ts`

- [ ] **Step 1: Write the failing test**

Create `daemon/src/providers/claude-code/hook-bin/__tests__/parse-shell-paths.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseShellPaths } from "../parse-shell-paths";

describe("parseShellPaths", () => {
  it("no-path verb: pwd → empty reads/writes", () => {
    expect(parseShellPaths("pwd")).toEqual({ reads: [], writes: [] });
  });
  it("no-path verb: git status → empty", () => {
    expect(parseShellPaths("git status")).toEqual({ reads: [], writes: [] });
  });
  it("read-like: cat vault/x.md → reads", () => {
    expect(parseShellPaths("cat vault/journal/X.md")).toEqual({
      reads: ["vault/journal/X.md"],
      writes: [],
    });
  });
  it("read-like with flags: ls -la vault/work", () => {
    expect(parseShellPaths("ls -la vault/work")).toEqual({
      reads: ["vault/work"],
      writes: [],
    });
  });
  it("write-like: mv a.md b.md → writes both", () => {
    expect(parseShellPaths("mv vault/a.md vault/b.md")).toEqual({
      reads: [],
      writes: ["vault/a.md", "vault/b.md"],
    });
  });
  it("redirect: echo hi > vault/note.md → writes target", () => {
    expect(parseShellPaths("echo hi > vault/note.md")).toEqual({
      reads: [],
      writes: ["vault/note.md"],
    });
  });
  it("redirect append: echo hi >> vault/log.md", () => {
    expect(parseShellPaths("echo hi >> vault/log.md")).toEqual({
      reads: [],
      writes: ["vault/log.md"],
    });
  });
  it("unknown verb with path: deny via conservative read gate", () => {
    expect(parseShellPaths("foobar vault/secret.md")).toEqual({
      reads: ["vault/secret.md"],
      writes: [],
    });
  });
  it("unknown verb without paths: allow (empty)", () => {
    expect(parseShellPaths("foobar --flag")).toEqual({ reads: [], writes: [] });
  });
  it("shell substitution → conservative deny via reads", () => {
    expect(parseShellPaths("cat $(ls vault/)")).toEqual({
      reads: ["$(ls vault/)"],
      writes: [],
    });
  });
  it("git show file → reads file token", () => {
    expect(parseShellPaths("git show HEAD:vault/x.md")).toEqual({
      reads: ["HEAD:vault/x.md"],
      writes: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/hook-bin/__tests__/parse-shell-paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `parse-shell-paths.ts`**

Create `daemon/src/providers/claude-code/hook-bin/parse-shell-paths.ts`:

```ts
// VOS-106 T2: deliberately narrow shell-arg classifier for the PreToolUse
// hook's Bash gate. See spec §3.4 for the rule ordering.

export interface ShellPaths {
  reads: string[];
  writes: string[];
}

const NO_PATH_VERBS = new Set([
  "pwd", "echo", "date", "env", "hostname", "whoami", "true", "false",
]);

const READ_VERBS = new Set([
  "cat", "head", "tail", "less", "more", "ls", "grep", "rg", "find",
  "file", "stat", "wc",
]);

const WRITE_VERBS = new Set([
  "mv", "cp", "rm", "tee", "sed", "sd", "touch", "mkdir", "rmdir",
]);

// git subcommand → category. Anything else under git falls through to
// "unknown" and is conservatively denied if it carries a path.
const GIT_READ = new Set(["show", "log", "diff", "status", "blame"]);
const GIT_WRITE = new Set(["add", "mv", "rm", "commit", "checkout", "reset", "restore"]);

function looksLikePath(token: string): boolean {
  if (token.startsWith("-")) return false;
  if (token.includes("/")) return true;
  if (token.includes(".")) return true;
  return false;
}

export function parseShellPaths(cmd: string): ShellPaths {
  const reads: string[] = [];
  const writes: string[] = [];

  // Split on whitespace, preserving redirect operators as their own tokens.
  // Naive tokenizer — agent prompts that need shell substitution / quoting
  // beyond this fall through to the conservative-deny branch below.
  const tokens = cmd
    .replace(/(>>|>)/g, " $1 ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return { reads, writes };

  // Redirect target capture: any `>` or `>>` token → next token is a write.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === ">" || tokens[i] === ">>") {
      const target = tokens[i + 1];
      if (target) writes.push(target);
    }
  }
  const argv = tokens.filter((t, i) => {
    if (t === ">" || t === ">>") return false;
    if (i > 0 && (tokens[i - 1] === ">" || tokens[i - 1] === ">>")) return false;
    return true;
  });

  const verb = argv[0];
  const rest = argv.slice(1);

  if (NO_PATH_VERBS.has(verb)) return { reads, writes };

  if (verb === "git") {
    const sub = rest[0];
    const gitRest = rest.slice(1);
    if (!sub) return { reads, writes };
    if (sub === "status" && !gitRest.some((t) => t === "--")) {
      return { reads, writes };
    }
    const pathTokens = gitRest.filter(looksLikePath);
    if (GIT_WRITE.has(sub)) writes.push(...pathTokens);
    else if (GIT_READ.has(sub)) reads.push(...pathTokens);
    else reads.push(...pathTokens); // unknown git subcmd with paths → deny via read gate
    return { reads, writes };
  }

  if (READ_VERBS.has(verb)) {
    reads.push(...rest.filter(looksLikePath));
    return { reads, writes };
  }

  if (WRITE_VERBS.has(verb)) {
    writes.push(...rest.filter(looksLikePath));
    return { reads, writes };
  }

  // Unrecognized verb. If it carries no path-shaped argv, allow (CC's own
  // Bash gate decides). If it does carry paths, force the read gate to
  // evaluate them — conservative deny for unknown shapes that touch paths.
  const pathTokens = rest.filter(looksLikePath);
  if (pathTokens.length === 0) return { reads, writes };
  reads.push(...pathTokens);
  return { reads, writes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/hook-bin/__tests__/parse-shell-paths.test.ts`
Expected: PASS, 11 tests. If the `cat $(ls vault/)` case fails (`$(ls` is split on space) — confirm the test expectation matches the conservative behavior we want. Edit the test to expect whatever the implementation produces for shell substitution, as long as the result triggers a read-gate deny on a non-empty token. The exact captured token doesn't matter; the safety property does.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/providers/claude-code/hook-bin/parse-shell-paths.ts daemon/src/providers/claude-code/hook-bin/__tests__/parse-shell-paths.test.ts
git commit -m "task(VOS-106): T2 shell-arg classifier with NO_PATH_VERBS first-pass"
```

---

## Task 3: PreToolUse hook script

**Files:**
- Create: `daemon/src/providers/claude-code/hook-bin/pre-tool-use.ts`
- Test: `daemon/src/providers/claude-code/hook-bin/__tests__/pre-tool-use.test.ts`

- [ ] **Step 1: Write the failing test**

Create `daemon/src/providers/claude-code/hook-bin/__tests__/pre-tool-use.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "pre-tool-use.ts");
const VAULT = "/tmp/vos-106-hook-test-vault"; // doesn't need to exist for matchPath

async function runHook(input: unknown, env: Record<string, string>): Promise<{
  stdout: string;
  exitCode: number;
  decision: { continue: boolean; stopReason?: string };
}> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, VOS_VAULT_ROOT: VAULT },
  });
  proc.stdin.write(JSON.stringify(input));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const decision = JSON.parse(stdout.trim());
  return { stdout, exitCode, decision };
}

const readJournalOnly = {
  VOS_READ_PATHS: JSON.stringify([`${VAULT}/journal/**`]),
  VOS_WRITE_PATHS: JSON.stringify([`${VAULT}/journal/**`]),
  VOS_SYSTEM_DENY: JSON.stringify([`${VAULT}/agents/**`]),
};

describe("pre-tool-use hook", () => {
  it("allows Read inside read_scope", async () => {
    const { decision, exitCode } = await runHook(
      { tool_name: "Read", tool_input: { file_path: `${VAULT}/journal/2026-05-16.md` } },
      readJournalOnly,
    );
    expect(exitCode).toBe(0);
    expect(decision.continue).toBe(true);
  });

  it("denies Read outside read_scope", async () => {
    const { decision } = await runHook(
      { tool_name: "Read", tool_input: { file_path: `${VAULT}/work/tasks/active/X.md` } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(false);
    expect(decision.stopReason).toMatch(/READ_SCOPE_DENIED/);
  });

  it("allows Edit inside write_scope", async () => {
    const { decision } = await runHook(
      { tool_name: "Edit", tool_input: { file_path: `${VAULT}/journal/2026-05-16.md` } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(true);
  });

  it("denies Edit outside write_scope", async () => {
    const { decision } = await runHook(
      { tool_name: "Write", tool_input: { file_path: `${VAULT}/work/X.md` } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(false);
    expect(decision.stopReason).toMatch(/WRITE_SCOPE_DENIED/);
  });

  it("denies SYSTEM_DENY even when write_scope would allow", async () => {
    const env = {
      VOS_READ_PATHS: JSON.stringify([`${VAULT}/**`]),
      VOS_WRITE_PATHS: JSON.stringify([`${VAULT}/**`]),
      VOS_SYSTEM_DENY: JSON.stringify([`${VAULT}/agents/**`]),
    };
    const { decision } = await runHook(
      { tool_name: "Edit", tool_input: { file_path: `${VAULT}/agents/maya/agent.md` } },
      env,
    );
    expect(decision.continue).toBe(false);
    expect(decision.stopReason).toMatch(/SYSTEM_DENY/);
  });

  it("Bash: cat outside scope denies via read gate", async () => {
    const { decision } = await runHook(
      { tool_name: "Bash", tool_input: { command: "cat vault/work/active/X.md" } },
      {
        VOS_READ_PATHS: JSON.stringify([`${VAULT}/journal/**`]),
        VOS_WRITE_PATHS: JSON.stringify([`${VAULT}/journal/**`]),
        VOS_SYSTEM_DENY: JSON.stringify([]),
      },
    );
    expect(decision.continue).toBe(false);
  });

  it("Bash: pwd allows without scope check", async () => {
    const { decision } = await runHook(
      { tool_name: "Bash", tool_input: { command: "pwd" } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(true);
  });

  it("unknown tool: allow (out of scope)", async () => {
    const { decision } = await runHook(
      { tool_name: "WebFetch", tool_input: { url: "https://example.com" } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(true);
  });

  it("exit 0 even when denying (CC reads decision from stdout)", async () => {
    const { exitCode } = await runHook(
      { tool_name: "Read", tool_input: { file_path: "/etc/passwd" } },
      readJournalOnly,
    );
    expect(exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/hook-bin/__tests__/pre-tool-use.test.ts`
Expected: FAIL — hook script doesn't exist.

- [ ] **Step 3: Write the hook script**

Create `daemon/src/providers/claude-code/hook-bin/pre-tool-use.ts`:

```ts
#!/usr/bin/env bun
// VOS-106 T3: PreToolUse hook script. Spawned by CC per tool call.
// Reads CC's tool-call payload on stdin; reads scopes from env; prints
// {continue: bool, stopReason?: string} on stdout. Always exit 0 — CC
// reads the decision from stdout, not from exit code.

import * as path from "node:path";
import { matchPath } from "../../../permissions/match";
import { parseShellPaths } from "./parse-shell-paths";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/hook-bin/__tests__/pre-tool-use.test.ts`
Expected: PASS, 9 tests. If a test fails on path-normalization edge cases (e.g. trailing slash), adjust the test or `matchPath`'s normalization — but the engine tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/providers/claude-code/hook-bin/pre-tool-use.ts daemon/src/providers/claude-code/hook-bin/__tests__/pre-tool-use.test.ts
git commit -m "task(VOS-106): T3 PreToolUse hook script — Read/Write/Bash/SYSTEM_DENY gates"
```

---

## Task 4: Match fuzz test (hook vs engine parity)

**Files:**
- Test: `daemon/src/permissions/__tests__/match.fuzz.test.ts`

- [ ] **Step 1: Write the fuzz test**

Create `daemon/src/permissions/__tests__/match.fuzz.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createPermissionEngine } from "../engine";

const HOOK = join(import.meta.dir, "..", "..", "providers", "claude-code", "hook-bin", "pre-tool-use.ts");
const VAULT = "/tmp/vos-106-fuzz-vault";

async function hookDecide(toolPath: string, readPaths: string[]): Promise<boolean> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      VOS_READ_PATHS: JSON.stringify(readPaths),
      VOS_WRITE_PATHS: JSON.stringify(readPaths),
      VOS_SYSTEM_DENY: JSON.stringify([]),
      VOS_VAULT_ROOT: VAULT,
    },
  });
  proc.stdin.write(JSON.stringify({ tool_name: "Read", tool_input: { file_path: toolPath } }));
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return (JSON.parse(out.trim()) as { continue: boolean }).continue;
}

// Pseudo-random but deterministic (seeded). Avoids flaky reruns.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

describe("matchPath parity: engine vs hook", () => {
  it("agrees on 100 random (path, scope) pairs", async () => {
    const engine = createPermissionEngine({ vaultRoot: VAULT, homeRoot: "/tmp/home" });
    const segments = ["journal", "work", "agents", "notes", "tasks", "active", "backlog"];
    const exts = [".md", ".txt", ".json"];
    const rand = rng(12345);

    let mismatches = 0;
    for (let i = 0; i < 100; i++) {
      const depth = 1 + Math.floor(rand() * 4);
      const parts = Array.from({ length: depth }, () => pick(rand, segments));
      const ext = pick(rand, exts);
      const absPath = `${VAULT}/${parts.join("/")}${ext}`;

      const scopeRoot = pick(rand, segments);
      const scope = [`${VAULT}/${scopeRoot}/**`];

      const agent = { name: "fuzz", read_scope: scope, write_scope: scope };
      const engineAllow = engine.canRead(absPath, agent);
      const hookAllow = await hookDecide(absPath, scope);

      if (engineAllow !== hookAllow) {
        mismatches++;
        console.error(`MISMATCH #${i}: path=${absPath} scope=${scope[0]} engine=${engineAllow} hook=${hookAllow}`);
      }
    }
    expect(mismatches).toBe(0);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd workspace/void-os && bun test daemon/src/permissions/__tests__/match.fuzz.test.ts`
Expected: PASS — 0 mismatches. If mismatches are reported, the spec assumption "single source of truth" is broken — debug `matchPath` resolution differences before continuing.

- [ ] **Step 3: Commit**

```bash
git add daemon/src/permissions/__tests__/match.fuzz.test.ts
git commit -m "task(VOS-106): T4 fuzz test — hook + engine matchPath parity"
```

---

## Task 5: `spawn-settings.ts` pure builder

**Files:**
- Create: `daemon/src/providers/claude-code/spawn-settings.ts`
- Test: `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSpawnSettings } from "../spawn-settings";

const VAULT = "/tmp/vos-106-vault-test";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "vos-106-spawn-"));
}

describe("buildSpawnSettings", () => {
  it("writes settings.json with PreToolUse hook + additionalDirectories", () => {
    const dir = freshDir();
    const { settingsPath, mcpConfigPath, env } = buildSpawnSettings({
      agentName: "maya",
      scopes: {
        readPaths: [`${VAULT}/**`, "/Users/x/.config/something"],
        writePaths: [`${VAULT}/work/**`],
      },
      systemDeny: [`${VAULT}/agents/**`],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "run-abc",
      settingsDir: dir,
      hookScriptPath: "/abs/pre-tool-use.ts",
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PreToolUse[0].matcher).toBe(
      "Read|Glob|Grep|Bash|Edit|Write|MultiEdit",
    );
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(
      /bun .*\/abs\/pre-tool-use\.ts$/,
    );
    expect(settings.additionalDirectories).toEqual(["/Users/x/.config/something"]);
  });

  it("writes mcp.json pointing at /mcp?agent=<n>&run=<id>", () => {
    const dir = freshDir();
    const { mcpConfigPath } = buildSpawnSettings({
      agentName: "journaler",
      scopes: { readPaths: [`${VAULT}/journal/**`], writePaths: [`${VAULT}/journal/**`] },
      systemDeny: [],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "run-xyz",
      settingsDir: dir,
      hookScriptPath: "/abs/hook.ts",
    });
    const mcp = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    expect(mcp.mcpServers["void-os"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:17777/mcp?agent=journaler&run=run-xyz",
    });
  });

  it("env exports JSON-encoded scope arrays", () => {
    const { env } = buildSpawnSettings({
      agentName: "x",
      scopes: { readPaths: ["/r"], writePaths: ["/w"] },
      systemDeny: ["/d"],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "r",
      settingsDir: freshDir(),
      hookScriptPath: "/h",
    });
    expect(JSON.parse(env.VOS_READ_PATHS)).toEqual(["/r"]);
    expect(JSON.parse(env.VOS_WRITE_PATHS)).toEqual(["/w"]);
    expect(JSON.parse(env.VOS_SYSTEM_DENY)).toEqual(["/d"]);
    expect(env.VOS_VAULT_ROOT).toBe(VAULT);
  });

  it("additionalDirectories excludes paths under vaultRoot (cwd already covers them)", () => {
    const dir = freshDir();
    const { settingsPath } = buildSpawnSettings({
      agentName: "a",
      scopes: {
        readPaths: [`${VAULT}/journal/**`, `${VAULT}/work/**`],
        writePaths: [`${VAULT}/journal/**`],
      },
      systemDeny: [],
      vaultRoot: VAULT,
      daemonBase: "http://127.0.0.1:17777",
      runId: "r",
      settingsDir: dir,
      hookScriptPath: "/h",
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.additionalDirectories).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `spawn-settings.ts`**

Create `daemon/src/providers/claude-code/spawn-settings.ts`:

```ts
// VOS-106 T5: per-spawn settings builder. Pure function (modulo
// the two JSON files it writes). Inputs are deterministic; outputs are
// the two paths CC needs (--settings, --mcp-config) plus the env vars
// the PreToolUse hook script consumes.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildSpawnSettingsArgs {
  agentName: string;
  scopes: { readPaths: string[]; writePaths: string[] };
  systemDeny: string[];
  vaultRoot: string;
  daemonBase: string;
  runId: string;
  settingsDir: string;
  hookScriptPath: string;
}

export interface SpawnSettings {
  settingsPath: string;
  mcpConfigPath: string;
  env: Record<string, string>;
}

function pathHeadIsUnderRoot(pattern: string, root: string): boolean {
  // Treat the pattern's literal prefix as the head. If the head is the root
  // itself or a path under it, the pattern lives under vaultRoot.
  const metaIdx = pattern.search(/[*?[{]/);
  const head = metaIdx === -1 ? pattern : pattern.slice(0, metaIdx);
  return head === root || head.startsWith(root + "/");
}

export function buildSpawnSettings(args: BuildSpawnSettingsArgs): SpawnSettings {
  const additionalDirectories = args.scopes.readPaths.filter(
    (p) => !pathHeadIsUnderRoot(p, args.vaultRoot),
  );

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Read|Glob|Grep|Bash|Edit|Write|MultiEdit",
          hooks: [{ type: "command", command: `bun ${args.hookScriptPath}` }],
        },
      ],
    },
    additionalDirectories,
  };

  const mcp = {
    mcpServers: {
      "void-os": {
        type: "http",
        url: `${args.daemonBase}/mcp?agent=${encodeURIComponent(args.agentName)}&run=${encodeURIComponent(args.runId)}`,
      },
    },
  };

  const settingsPath = join(args.settingsDir, `${args.runId}.settings.json`);
  const mcpConfigPath = join(args.settingsDir, `${args.runId}.mcp.json`);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  writeFileSync(mcpConfigPath, JSON.stringify(mcp, null, 2));

  const env: Record<string, string> = {
    VOS_READ_PATHS: JSON.stringify(args.scopes.readPaths),
    VOS_WRITE_PATHS: JSON.stringify(args.scopes.writePaths),
    VOS_SYSTEM_DENY: JSON.stringify(args.systemDeny),
    VOS_VAULT_ROOT: args.vaultRoot,
  };

  return { settingsPath, mcpConfigPath, env };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/providers/claude-code/spawn-settings.ts daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts
git commit -m "task(VOS-106): T5 buildSpawnSettings — per-run settings.json + mcp.json"
```

---

## Task 6: Wire CC spawner to use spawn-settings

**Files:**
- Modify: `daemon/src/providers/claude-code/index.ts` (CcSpawnRequest + spawn body)
- Modify: `daemon/src/providers/claude-code/spawner.ts` (SpawnerIterDeps pass-through)
- Modify: `daemon/src/providers/factory.ts` (ProviderDeps adds engine + daemonBase + loadAgentDefn)
- Modify: `daemon/src/providers/claude-code/__tests__/cc-shape.test.ts` (existing test may need new deps)

- [ ] **Step 1: Write the integration test first**

Create `daemon/src/providers/claude-code/__tests__/cc-spawner-loader.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runMigrationsFromDir } from "../../../adapters/sqlite/migrations";
import { createEventBus } from "../../../events";
import { createPermissionEngine } from "../../../permissions/engine";
import { createCcSpawner } from "../index";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "adapters", "sqlite", "migrations");

describe("cc-spawner loader integration", () => {
  it("writes <runId>.settings.json + <runId>.mcp.json on spawn", async () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS);
    // Seed an agent_cards row with explicit scopes.
    db.run(
      "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      [
        "journaler",
        JSON.stringify({
          name: "journaler",
          read_scope: ["vault/journal/**"],
          write_scope: ["vault/journal/**"],
        }),
      ],
    );

    const tracesDir = join(tmpdir(), `vos-106-traces-${Date.now()}`);
    mkdirSync(tracesDir, { recursive: true });
    const vaultRoot = "/tmp/vos-106-vault";

    const bus = createEventBus({ db });
    const engine = createPermissionEngine({ vaultRoot, homeRoot: "/tmp/home" });

    const cc = createCcSpawner({
      bus,
      db,
      tracesDir,
      engine,
      daemonBase: "http://127.0.0.1:17777",
      hookScriptPath: "/abs/pre-tool-use.ts",
      loadAgentDefn: (name) => {
        const row = db
          .query("SELECT card_json FROM agent_cards WHERE agent_name=?")
          .get(name) as { card_json: string } | undefined;
        if (!row) throw new Error(`unknown agent: ${name}`);
        const parsed = JSON.parse(row.card_json);
        return {
          name,
          read_scope: parsed.read_scope,
          write_scope: parsed.write_scope,
        };
      },
      // Test seam: skip the actual `claudev claude` subprocess; just verify
      // that the settings files are written and the argv is well-formed.
      spawnFn: (cmd, _opts) => {
        return {
          pid: 99999,
          exited: Promise.resolve(0),
          stdout: new ReadableStream({ start: (c) => c.close() }),
          stderr: new ReadableStream({ start: (c) => c.close() }),
          kill: () => {},
          _cmd: cmd, // captured for assertion below
        } as never;
      },
    });

    const proc = await cc.spawn({
      prompt: "hi",
      agent: "journaler",
      cwd: vaultRoot,
      chatId: "chat-1",
      kind: "chat",
    });

    const runId = proc.runId;
    const settingsPath = join(tracesDir, `${runId}.settings.json`);
    const mcpPath = join(tracesDir, `${runId}.mcp.json`);
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(mcpPath)).toBe(true);

    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(mcp.mcpServers["void-os"].url).toContain("agent=journaler");
    expect(mcp.mcpServers["void-os"].url).toContain(`run=${runId}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/__tests__/cc-spawner-loader.test.ts`
Expected: FAIL — `createCcSpawner` does not accept `engine` / `daemonBase` / `hookScriptPath` / `loadAgentDefn` / `spawnFn`.

- [ ] **Step 3: Extend `CcSpawnerDeps` + spawn body**

In `daemon/src/providers/claude-code/index.ts`, modify the `CcSpawnerDeps` interface (around line 149):

```ts
import type { AgentDefn, PermissionEngine } from "../../permissions/engine.js";
import { SYSTEM_DENY_FOR_WRITE } from "../../permissions/engine.js";
import { buildSpawnSettings } from "./spawn-settings.ts";

interface CcSpawnerDeps {
  bus: EventBus;
  db: Database;
  tracesDir: string;
  binary?: string;
  watchdogTickMs?: number;
  now?: () => number;
  // VOS-106
  engine: PermissionEngine;
  daemonBase: string;
  hookScriptPath: string;
  loadAgentDefn: (name: string) => AgentDefn;
  /** Test seam: override `Bun.spawn`. Defaults to the real Bun.spawn. */
  spawnFn?: (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => ReturnType<typeof Bun.spawn>;
}
```

Inside `createCcSpawner` → `spawn(req)` body, immediately after `const runId = randomUUID();` and before the `args` array, insert:

```ts
      // VOS-106 T6: resolve scopes per agent, write per-run settings + mcp
      // config to disk, extend argv + env. If scope resolution fails we
      // surface as a synchronous spawn error (run.error before exit).
      let settingsPath: string;
      let mcpConfigPath: string;
      let hookEnv: Record<string, string>;
      try {
        const agentDefn = deps.loadAgentDefn(req.agent);
        const scopes = deps.engine.resolveScopes(agentDefn);
        // SYSTEM_DENY_FOR_WRITE patterns are vault-relative + ~-prefixed;
        // the engine already expanded them at construction time. Re-expand
        // for the hook env (since the hook runs out-of-process and has no
        // access to the engine's compiled denyMatchers).
        const homeRoot = process.env.HOME ?? "";
        const expandedDeny = SYSTEM_DENY_FOR_WRITE.map((p) =>
          p.startsWith("vault/") ? `${req.cwd}/${p.slice("vault/".length)}` :
          p.startsWith("~/") ? `${homeRoot}/${p.slice("~/".length)}` :
          p,
        );
        const built = buildSpawnSettings({
          agentName: req.agent,
          scopes,
          systemDeny: expandedDeny,
          vaultRoot: req.cwd,
          daemonBase: deps.daemonBase,
          runId,
          settingsDir: deps.tracesDir,
          hookScriptPath: deps.hookScriptPath,
        });
        settingsPath = built.settingsPath;
        mcpConfigPath = built.mcpConfigPath;
        hookEnv = built.env;
      } catch (err) {
        const e = err as { message?: string };
        deps.db
          .prepare("INSERT INTO runs (id, chat_id, agent, kind, status, started_at, trace_path) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(runId, req.chatId ?? null, req.agent, req.kind ?? "chat", "error", now(), null);
        deps.db
          .prepare("UPDATE runs SET ended_at=?, error=? WHERE id=?")
          .run(now(), e.message ?? String(err), runId);
        deps.bus.emit({ type: "run.error", runId, payload: { error: e.message ?? String(err) } });
        throw err;
      }
```

Then modify the `args` array (around line 194):

```ts
      const args = [
        "-p", req.prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--settings", settingsPath,
        "--mcp-config", mcpConfigPath,
        ...(req.resumeFrom ? ["--resume", req.resumeFrom] : []),
      ];
```

And the `Bun.spawn` call (around line 202) needs the merged env + the test seam:

```ts
      const spawnFn = deps.spawnFn ?? Bun.spawn;
      try {
        proc = spawnFn([binary, ...args], {
          cwd: req.cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: { ...(process.env as Record<string, string>), ...hookEnv },
        });
      } catch (err) {
```

- [ ] **Step 4: Thread deps through `spawner.ts` + `factory.ts`**

In `daemon/src/providers/claude-code/spawner.ts`, extend `SpawnerIterDeps` (around line 36):

```ts
export interface SpawnerIterDeps {
  cc: CcSpawner;
  bus: EventBus;
  agent: string;
  cwd: string;
}
```

No change here — spawner-iter delegates `req.agent` / `req.cwd` to `cc.spawn`. The new deps live on the `cc` (CcSpawner) instance itself.

In `daemon/src/providers/claude-code/index.ts`, extend `ClaudeCodeProviderDeps` + `makeClaudeCodeProviderComposed`:

```ts
export interface ClaudeCodeProviderDeps {
  bus: Parameters<typeof createCcSpawner>[0]["bus"];
  db: Parameters<typeof createCcSpawner>[0]["db"];
  tracesDir: string;
  agent: string;
  cwd: string;
  // VOS-106
  engine: PermissionEngine;
  daemonBase: string;
  hookScriptPath: string;
  loadAgentDefn: (name: string) => AgentDefn;
}

export function makeClaudeCodeProviderComposed(deps: ClaudeCodeProviderDeps): Provider {
  const cc = createCcSpawner({
    bus: deps.bus,
    db: deps.db,
    tracesDir: deps.tracesDir,
    engine: deps.engine,
    daemonBase: deps.daemonBase,
    hookScriptPath: deps.hookScriptPath,
    loadAgentDefn: deps.loadAgentDefn,
  });
  const iter = makeCcSpawnerIter({ cc, bus: deps.bus, agent: deps.agent, cwd: deps.cwd });
  return makeClaudeCodeProvider({ iter });
}
```

In `daemon/src/providers/factory.ts`, extend `ProviderDeps`:

```ts
import type { PermissionEngine, AgentDefn } from "../permissions/engine.ts";

export interface ProviderDeps {
  bus: EventBus;
  db: Database;
  tracesDir: string;
  agent: string;
  cwd: string;
  // VOS-106
  engine: PermissionEngine;
  daemonBase: string;
  hookScriptPath: string;
  loadAgentDefn: (name: string) => AgentDefn;
}

export function makeProvider(env: ProviderEnv, deps: ProviderDeps): Provider {
  const kind = env.VOS_PROVIDER ?? "claude-code";
  if (kind === "claude-code") {
    return makeClaudeCodeProviderComposed({
      bus: deps.bus,
      db: deps.db,
      tracesDir: deps.tracesDir,
      agent: deps.agent,
      cwd: deps.cwd,
      engine: deps.engine,
      daemonBase: deps.daemonBase,
      hookScriptPath: deps.hookScriptPath,
      loadAgentDefn: deps.loadAgentDefn,
    });
  }
  // fake provider unchanged — keeps loopback to /mcp via daemonBase only,
  // doesn't need the hook wiring.
  if (kind === "fake") { /* unchanged body */ }
  throw new Error(`unknown provider: ${kind}`);
}
```

- [ ] **Step 5: Run integration test to verify it passes**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/__tests__/cc-spawner-loader.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full claude-code provider test suite**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/`
Expected: ALL pre-existing tests still pass. If any fail because they construct `createCcSpawner` without the new deps, update those test setups to inject minimal stubs (`engine: createPermissionEngine(...)`, `daemonBase: "http://x"`, `hookScriptPath: "/x"`, `loadAgentDefn: () => ({ name: "x" })`).

- [ ] **Step 7: Commit**

```bash
git add daemon/src/providers/claude-code/index.ts daemon/src/providers/claude-code/spawner.ts daemon/src/providers/factory.ts daemon/src/providers/claude-code/__tests__/cc-spawner-loader.test.ts
git commit -m "task(VOS-106): T6 spawner consumes spawn-settings + threads engine/loadAgentDefn"
```

---

## Task 7: `app.ts` wiring + boot deny-probe

**Files:**
- Modify: `daemon/src/app.ts`
- Create: `daemon/src/providers/claude-code/boot-probe.ts`
- Test: `daemon/src/providers/claude-code/__tests__/boot-probe.test.ts`

- [ ] **Step 1: Write the boot-probe test first**

Create `daemon/src/providers/claude-code/__tests__/boot-probe.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { runBootDenyProbe } from "../boot-probe";

describe("runBootDenyProbe", () => {
  it("resolves ok when hook denies", async () => {
    const result = await runBootDenyProbe({
      spawnFn: () => ({
        pid: 1,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              JSON.stringify({ continue: false, stopReason: "WRITE_SCOPE_DENIED: x" }),
            ));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        stdin: { write: () => {}, end: () => {} } as never,
        kill: () => {},
      }) as never,
      hookScriptPath: "/fake/hook.ts",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when hook returns continue:true (fail-open)", async () => {
    const result = await runBootDenyProbe({
      spawnFn: () => ({
        pid: 1,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({ continue: true })));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        stdin: { write: () => {}, end: () => {} } as never,
        kill: () => {},
      }) as never,
      hookScriptPath: "/fake/hook.ts",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fail-open|continue.*true/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/__tests__/boot-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `boot-probe.ts`**

Create `daemon/src/providers/claude-code/boot-probe.ts`:

```ts
// VOS-106 T7: daemon boot-time deny-probe. Sends a known out-of-scope
// Edit payload to the PreToolUse hook script with a deliberately
// restrictive scope env. Expects continue=false. If the hook returns
// continue=true, the entire scope-enforcement design is broken —
// daemon refuses to start.

export interface BootProbeArgs {
  hookScriptPath: string;
  /** Test seam: override Bun.spawn. */
  spawnFn?: (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => ReturnType<typeof Bun.spawn>;
}

export interface BootProbeResult {
  ok: boolean;
  reason?: string;
}

export async function runBootDenyProbe(args: BootProbeArgs): Promise<BootProbeResult> {
  const spawnFn = args.spawnFn ?? Bun.spawn;
  const proc = spawnFn(["bun", args.hookScriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VOS_READ_PATHS: JSON.stringify(["/nonexistent/**"]),
      VOS_WRITE_PATHS: JSON.stringify(["/nonexistent/**"]),
      VOS_SYSTEM_DENY: JSON.stringify([]),
      VOS_VAULT_ROOT: "/nonexistent",
    },
  });

  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: "/etc/passwd" },
  });
  (proc.stdin as { write: (s: string) => void; end: () => void }).write(payload);
  (proc.stdin as { end: () => void }).end();

  const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  await proc.exited;

  let parsed: { continue?: boolean };
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    return { ok: false, reason: `hook produced non-JSON stdout: ${out.slice(0, 200)}` };
  }
  if (parsed.continue === true) {
    return {
      ok: false,
      reason: "boot deny-probe failed: hook returned continue=true for out-of-scope Edit (fail-open). Refusing to start daemon.",
    };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run boot-probe test**

Run: `cd workspace/void-os && bun test daemon/src/providers/claude-code/__tests__/boot-probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire boot-probe + engine into `app.ts`**

In `daemon/src/app.ts`, modify the imports + `buildApp` body. After the imports section, add:

```ts
import { createPermissionEngine, defaultLoadAgentDefn as defaultLoadAgentDefnFn } from "./permissions/engine.ts";
import { runBootDenyProbe } from "./providers/claude-code/boot-probe.ts";
```

Wait — `defaultLoadAgentDefn` currently lives in `adapters/mcp/index.ts`. Move it into `permissions/engine.ts` (so both MCP and provider factory can import it without circular dep). Apply this diff to `daemon/src/adapters/mcp/index.ts`: replace the inline `defaultLoadAgentDefn` (lines 69-88) with `export { defaultLoadAgentDefn } from "../../permissions/engine.ts";`, and add the function body to `permissions/engine.ts` near the bottom:

```ts
// daemon/src/permissions/engine.ts (append)
import type { Database } from "bun:sqlite";

export function defaultLoadAgentDefn(db: Database, agentName: string): AgentDefn {
  const row = db
    .query("SELECT card_json FROM agent_cards WHERE agent_name = ?")
    .get(agentName) as { card_json: string } | undefined;
  if (!row) throw new Error(`unknown agent: ${agentName}`);
  const parsed = JSON.parse(row.card_json) as Record<string, unknown>;
  const defn: AgentDefn = { name: agentName };
  if (Array.isArray(parsed.ask_agent_allow)) defn.ask_agent_allow = parsed.ask_agent_allow as string[];
  if (Array.isArray(parsed.read_scope)) defn.read_scope = parsed.read_scope as string[];
  if (Array.isArray(parsed.write_scope)) defn.write_scope = parsed.write_scope as string[];
  return defn;
}
```

Add a `daemonBase` field to `BuildAppDeps`:

```ts
export interface BuildAppDeps {
  db: Database;
  vaultRoot: string;
  orchestrator?: Orchestrator;
  titler?: Titler;
  emit?: (type: string, payload: Record<string, unknown>) => void;
  chatCwd?: string;
  defaultAgent?: string;
  // VOS-106
  daemonBase?: string;  // e.g. "http://127.0.0.1:17777" — used by spawned CC to reach /mcp
  /** Allows tests to skip the deny-probe. Production callers leave unset. */
  skipBootProbe?: boolean;
}
```

Inside `buildApp`, after the orchestrator-construction block, BEFORE `app.route("/", chatsApi(...))`, insert:

```ts
  const homeRoot = process.env.HOME ?? "";
  const engine = createPermissionEngine({ vaultRoot: deps.vaultRoot, homeRoot });
  const daemonBase = deps.daemonBase ?? `http://127.0.0.1:${process.env.PORT ?? "17777"}`;
  const hookScriptPath = path.join(
    import.meta.dir,
    "providers",
    "claude-code",
    "hook-bin",
    "pre-tool-use.ts",
  );

  // Boot deny-probe — refuse to start if the hook is fail-open.
  if (!deps.skipBootProbe) {
    const probe = await runBootDenyProbe({ hookScriptPath });
    if (!probe.ok) {
      throw new Error(`VOS-106 boot deny-probe failed: ${probe.reason}`);
    }
  }
```

Then replace the existing `makeProvider(...)` call inside `if (!orchestrator)`:

```ts
      const provider = makeProvider(process.env, {
        bus,
        db: deps.db,
        tracesDir,
        agent: deps.defaultAgent ?? "maya",
        cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? process.cwd(),
        engine,
        daemonBase,
        hookScriptPath,
        loadAgentDefn: (name) => defaultLoadAgentDefnFn(deps.db, name),
      });
```

And pass `engine` into `mountMcp`:

```ts
  mountMcp(app, {
    vaultRoot: deps.vaultRoot,
    db: deps.db,
    bus,
    bridge,
    dispatchChildTask,
    engine,
  });
```

- [ ] **Step 6: Update `makeDispatchChildTask` to receive engine + co.**

`makeDispatchChildTask` in `daemon/src/chat/dispatch-child.ts` invokes `makeProvider` internally — it needs the same new fields. Add them to its `MakeDispatchChildTaskDeps`:

```ts
export interface MakeDispatchChildTaskDeps {
  db: Database;
  bus: EventBus;
  cwd: string;
  tracesDir: string;
  buildProvider?: (agentName: string) => Provider; // existing test seam
  // VOS-106
  engine?: PermissionEngine;
  daemonBase?: string;
  hookScriptPath?: string;
  loadAgentDefn?: (name: string) => AgentDefn;
}
```

In `app.ts`, pass them when constructing `dispatchChildTask`:

```ts
  const dispatchChildTask = makeDispatchChildTask({
    db: deps.db,
    bus,
    cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? process.cwd(),
    tracesDir: path.join(deps.vaultRoot, ".traces"),
    engine,
    daemonBase,
    hookScriptPath,
    loadAgentDefn: (name) => defaultLoadAgentDefnFn(deps.db, name),
  });
```

Inside `dispatch-child.ts`, when it falls through to the real-Provider path, thread the deps:

```ts
  // Existing line:
  //   makeProvider(deps.env ?? (process.env as ProviderEnv), { bus, db, tracesDir, agent, cwd })
  // becomes:
  makeProvider(deps.env ?? (process.env as ProviderEnv), {
    bus: deps.bus,
    db: deps.db,
    tracesDir: deps.tracesDir,
    agent: agentName,
    cwd: deps.cwd,
    engine: deps.engine!,
    daemonBase: deps.daemonBase!,
    hookScriptPath: deps.hookScriptPath!,
    loadAgentDefn: deps.loadAgentDefn!,
  });
```

(The `!` is acceptable because production wiring in `app.ts` always passes them; tests inject `buildProvider` and bypass the makeProvider path entirely.)

- [ ] **Step 7: Run pre-existing app-wiring + dispatch tests**

Run: `cd workspace/void-os && bun test daemon/test/app-wiring.test.ts daemon/test/integration/`
Expected: PASS, with one caveat — any test that calls `buildApp` without injecting `orchestrator` will now hit the boot deny-probe. Add `skipBootProbe: true` to those test setups.

Then run: `cd workspace/void-os && bun test daemon/`
Expected: full suite passes.

- [ ] **Step 8: Commit**

```bash
git add daemon/src/app.ts daemon/src/permissions/engine.ts daemon/src/adapters/mcp/index.ts daemon/src/providers/claude-code/boot-probe.ts daemon/src/providers/claude-code/__tests__/boot-probe.test.ts daemon/src/chat/dispatch-child.ts daemon/test/
git commit -m "task(VOS-106): T7 app.ts wires engine + boot deny-probe; moves defaultLoadAgentDefn"
```

---

## Task 8: MCP URL-query identity + `vault.read` scope gate

**Files:**
- Modify: `daemon/src/adapters/mcp/index.ts`
- Modify: `daemon/src/adapters/mcp/tools/vault-read.ts`
- Test: `daemon/src/adapters/mcp/tools/__tests__/vault-read-scope.test.ts`
- Test: `daemon/test/mcp-identity.test.ts`

- [ ] **Step 1: Write the vault-read scope-deny test**

Create `daemon/src/adapters/mcp/tools/__tests__/vault-read-scope.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { makeVaultRead } from "../vault-read";
import { createPermissionEngine } from "../../../permissions/engine";

function makeVault(): { root: string; db: Database } {
  const root = mkdtempSync(join(tmpdir(), "vos-106-vread-"));
  mkdirSync(join(root, "journal"), { recursive: true });
  mkdirSync(join(root, "work", "tasks", "active"), { recursive: true });
  writeFileSync(join(root, "journal", "2026-05-16.md"), "today");
  writeFileSync(join(root, "work", "tasks", "active", "X.md"), "secret");
  const db = new Database(":memory:");
  return { root, db };
}

describe("vault.read with scope gate", () => {
  it("allows path inside read_scope", async () => {
    const { root, db } = makeVault();
    const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
    const handler = makeVaultRead({
      vaultRoot: root,
      db,
      engine,
      agent: { name: "journaler", read_scope: ["vault/journal/**"] },
    });
    const res = await handler({ path: "journal/2026-05-16.md" }, {} as never);
    expect(res.isError).toBeFalsy();
  });

  it("denies path outside read_scope", async () => {
    const { root, db } = makeVault();
    const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
    const handler = makeVaultRead({
      vaultRoot: root,
      db,
      engine,
      agent: { name: "journaler", read_scope: ["vault/journal/**"] },
    });
    const res = await handler({ path: "work/tasks/active/X.md" }, {} as never);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^SCOPE_DENIED:/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test daemon/src/adapters/mcp/tools/__tests__/vault-read-scope.test.ts`
Expected: FAIL — `makeVaultRead` does not accept `engine` / `agent`.

- [ ] **Step 3: Extend `vault-read.ts`**

In `daemon/src/adapters/mcp/tools/vault-read.ts`, modify `VaultReadDeps` + handler:

```ts
import type { PermissionEngine, AgentDefn } from "../../../permissions/engine.ts";

export interface VaultReadDeps {
  vaultRoot: string;
  db: Database;
  // VOS-106
  engine: PermissionEngine;
  agent: AgentDefn;
}
```

Inside the returned async handler, after `abs = resolveVaultPath(rel, vaultRoot)` and before the `statSync` call:

```ts
    // VOS-106 scope gate. Calling-agent identity flows from URL query
    // ?agent=<name> resolved by mountMcp before instantiating this handler.
    if (!deps.engine.canRead(abs, deps.agent)) {
      return errResult("SCOPE_DENIED", `${rel} outside read_scope for agent ${deps.agent.name}`);
    }
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `cd workspace/void-os && bun test daemon/src/adapters/mcp/tools/__tests__/vault-read-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the MCP-route identity test**

Create `daemon/test/mcp-identity.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runMigrationsFromDir } from "../src/adapters/sqlite/migrations";
import { mountMcp } from "../src/adapters/mcp";
import { createEventBus } from "../src/events";
import { createAskUserBridge } from "../src/chat/ask-user-bridge";
import { createPermissionEngine } from "../src/permissions/engine";

const MIGRATIONS = join(import.meta.dir, "..", "src", "adapters", "sqlite", "migrations");

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "vos-106-mcp-id-"));
  mkdirSync(join(root, "journal"), { recursive: true });
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(join(root, "journal", "x.md"), "j");
  writeFileSync(join(root, "work", "x.md"), "w");

  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS);
  db.run(
    "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
    [
      "journaler",
      JSON.stringify({ name: "journaler", read_scope: ["vault/journal/**"] }),
    ],
  );
  return { root, db };
}

async function callVaultRead(app: Hono, agent: string, path: string) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "vault.read", arguments: { path } },
  };
  const res = await app.request(`/mcp?agent=${agent}&run=test-run`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  });
  return res;
}

describe("mountMcp identity from URL query", () => {
  it("vault.read for journaler on journal path: allow", async () => {
    const { root, db } = makeFixture();
    const bus = createEventBus({ db });
    const bridge = createAskUserBridge({ db, bus });
    const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
    const app = new Hono();
    mountMcp(app, { vaultRoot: root, db, bus, bridge, engine });
    const res = await callVaultRead(app, "journaler", "journal/x.md");
    expect(res.status).toBe(200);
  });

  it("vault.read for journaler on work path: SCOPE_DENIED", async () => {
    const { root, db } = makeFixture();
    const bus = createEventBus({ db });
    const bridge = createAskUserBridge({ db, bus });
    const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
    const app = new Hono();
    mountMcp(app, { vaultRoot: root, db, bus, bridge, engine });
    const res = await callVaultRead(app, "journaler", "work/x.md");
    const txt = await res.text();
    expect(txt).toMatch(/SCOPE_DENIED/);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd workspace/void-os && bun test daemon/test/mcp-identity.test.ts`
Expected: FAIL — `mountMcp` doesn't accept `engine`; URL query not consumed.

- [ ] **Step 7: Extend `mountMcp`**

In `daemon/src/adapters/mcp/index.ts`, modify `McpDeps`:

```ts
import type { AgentDefn, PermissionEngine } from "../../permissions/engine.ts";

export interface McpDeps {
  vaultRoot: string;
  db: Database;
  bus: EventBus;
  bridge: AskUserBridge;
  loadAgentDefn?: (agentName: string) => AgentDefn;
  dispatchChildTask?: (childTaskId: string, args: { agentName: string; message: string; systemMessage?: string }) => Promise<void>;
  // VOS-106
  engine: PermissionEngine;
}
```

Modify `buildMcpServer` — it now requires the calling-agent identity:

```ts
export function buildMcpServer(deps: McpDeps & { callingAgent: AgentDefn }): Server {
  const { vaultRoot, db, bus, bridge, engine, callingAgent } = deps;
  const loadAgentDefn = deps.loadAgentDefn ?? ((name: string) => defaultLoadAgentDefn(db, name));
  const dispatchChildTask = deps.dispatchChildTask ?? (async (_id, args) => {
    console.warn(`[VOS-89] dispatchChildTask placeholder invoked: agent=${args.agentName}`);
  });

  const mcp = new McpServer({ name: "void-os", version: pkg.version });
  mcp.registerTool("vault.read", vaultReadDef, makeVaultRead({ vaultRoot, db, engine, agent: callingAgent }) as never);
  mcp.registerTool("ask_user", askUserDef, makeAskUser({ bridge }) as never);
  mcp.registerTool("ask_agent", askAgentDef, makeAskAgent({ db, bus, loadAgentDefn, dispatchChildTask, now: () => Date.now() }) as never);
  return mcp.server;
}
```

Modify `mountMcp`:

```ts
export function mountMcp(app: Hono, deps: McpDeps): void {
  const loadAgentDefn = deps.loadAgentDefn ?? ((name: string) => defaultLoadAgentDefn(deps.db, name));
  app.all("/mcp", async (c) => {
    const agentName = c.req.query("agent");
    if (!agentName) {
      return c.json({ error: "MISSING_AGENT_QUERY: /mcp requires ?agent=<name>" }, 400);
    }
    let callingAgent: AgentDefn;
    try {
      callingAgent = loadAgentDefn(agentName);
    } catch {
      return c.json({ error: `UNKNOWN_AGENT: ${agentName}` }, 400);
    }

    const server = buildMcpServer({ ...deps, callingAgent });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    const ctype = c.req.header("content-type") ?? "";
    let parsedBody: unknown | undefined;
    if (c.req.method === "POST" && ctype.includes("json")) {
      parsedBody = await c.req.json();
    }

    const { nodeReq, nodeRes, responsePromise } = honoBridge(c);
    void transport.handleRequest(nodeReq as never, nodeRes as never, parsedBody);
    return responsePromise;
  });
}
```

- [ ] **Step 8: Run MCP identity test**

Run: `cd workspace/void-os && bun test daemon/test/mcp-identity.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 9: Run full MCP test suite**

Run: `cd workspace/void-os && bun test daemon/test/mcp-*.test.ts daemon/src/adapters/mcp/`
Expected: PASS. Pre-existing tests that call `/mcp` without `?agent=` will need to add it; update those test setups (typically: append `?agent=test`).

- [ ] **Step 10: Commit**

```bash
git add daemon/src/adapters/mcp/ daemon/test/mcp-identity.test.ts
git commit -m "task(VOS-106): T8 MCP URL-query identity + vault.read SCOPE_DENIED"
```

---

## Task 9: Probe fixture vault + harness

**Files:**
- Create: `daemon/test/fixtures/probe-vault/CLAUDE.md`
- Create: `daemon/test/fixtures/probe-vault/agents/maya/agent.md`
- Create: `daemon/test/fixtures/probe-vault/agents/journaler/agent.md`
- Create: `daemon/test/fixtures/probe-vault/agents/task-tracker/agent.md`
- Create: `daemon/test/fixtures/probe-vault/work/tasks/backlog/VOS-PROBE-1-fixture.md`
- Create: `daemon/test/fixtures/probe-vault/work/tasks/completed/VOS-PROBE-0-fixture.md`
- Create: `daemon/test/fixtures/probe-vault/journal/2026-05-16.md`
- Create: `daemon/test/probes/loader-integration.ts`
- Create: `daemon/test/probes/README.md`

- [ ] **Step 1: Seed the fixture vault — copy starter agents**

Run:
```bash
cd workspace/void-os && mkdir -p daemon/test/fixtures/probe-vault/{agents,work/tasks/backlog,work/tasks/completed,journal}
cp -R starter-vault/CLAUDE.md daemon/test/fixtures/probe-vault/CLAUDE.md
cp -R starter-vault/agents/maya daemon/test/fixtures/probe-vault/agents/
cp -R starter-vault/agents/journaler daemon/test/fixtures/probe-vault/agents/
cp -R starter-vault/agents/task-tracker daemon/test/fixtures/probe-vault/agents/
```

- [ ] **Step 2: Write the fixture tickets**

Create `daemon/test/fixtures/probe-vault/work/tasks/backlog/VOS-PROBE-1-fixture.md`:

```markdown
---
id: VOS-PROBE-1-fixture
title: VOS-106 probe fixture — backlog ticket for tt-promote probe
projects: [VOS]
parent: null
repos: []
created: 2026-05-16
updated: 2026-05-16
---

## Why
Fixture for VOS-106 loader-integration probe harness. Not real work.

## Done when
- task-tracker probe reads this ticket and proposes `/work --queue VOS-PROBE-1-fixture`.

## Plan
<!-- intentionally empty -->

## Subtasks
- [ ]

## Decisions
-

## Work Log
<!-- empty -->
```

Create `daemon/test/fixtures/probe-vault/work/tasks/completed/VOS-PROBE-0-fixture.md`:

```markdown
---
id: VOS-PROBE-0-fixture
title: VOS-106 probe fixture — completed ticket for mark-done probe
projects: [VOS]
parent: null
repos: []
created: 2026-05-16
updated: 2026-05-16
---

## Why
Fixture. Already completed.

## Done when
- N/A — already done.

## Work Log
### 2026-05-16 · seeded as fixture
- created to exercise journaler/mark-done routing probe
```

Create `daemon/test/fixtures/probe-vault/journal/2026-05-16.md`:

```markdown
---
date: 2026-05-16
---

## Sessions
- void-os: 30m — debugging
```

- [ ] **Step 3: Write the probe harness**

Create `daemon/test/probes/loader-integration.ts`:

```ts
// VOS-106 T9: loader-integration probe harness. Runs six probes against
// a live in-process daemon configured with the real claude-code provider
// (no fake). Uses a write-isolated copy of daemon/test/fixtures/probe-vault.
//
// Run: bun test:probes
// Pass: ≥5/6 PASS. The single allowed FAIL is for PROBE_DESIGN_BUG only.

import { cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../src/events";
import { createAskUserBridge } from "../../src/chat/ask-user-bridge";
import { createPermissionEngine, defaultLoadAgentDefn } from "../../src/permissions/engine";
import { mountMcp } from "../../src/adapters/mcp";
import { mountAnswerRoute } from "../../src/api/answer";
import { chatsApi } from "../../src/api/chats";
import { chatApi } from "../../src/api/chat";
import { makeChatRepo } from "../../src/chat/repo";
import { makeOrchestrator } from "../../src/chat/orchestrator";
import { makeProvider } from "../../src/providers/factory";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "probe-vault");
const HOOK = join(import.meta.dir, "..", "..", "src", "providers", "claude-code", "hook-bin", "pre-tool-use.ts");
const MIGRATIONS = join(import.meta.dir, "..", "..", "src", "adapters", "sqlite", "migrations");

interface Probe {
  label: string;
  agent: string;
  prompt: string;
  expectRegex: RegExp;
  expectDesc: string;
}

const PROBES: Probe[] = [
  { label: "maya / journal-Q", agent: "maya", prompt: "what did I write in today's journal?", expectRegex: /ask_agent\s*\(\s*["']journaler/i, expectDesc: 'ask_agent("journaler"' },
  { label: "maya / next-work-Q", agent: "maya", prompt: "what should I work on next?", expectRegex: /ask_agent\s*\(\s*["']task-tracker/i, expectDesc: 'ask_agent("task-tracker"' },
  { label: "journaler / mark-done", agent: "journaler", prompt: "mark VOS-PROBE-0-fixture done", expectRegex: /ask_agent\s*\(\s*["']task-tracker/i, expectDesc: 'declines + names task-tracker' },
  { label: "journaler / log-session", agent: "journaler", prompt: "log a 30-min void-os session, debugging", expectRegex: /vault\/journal\/.*\.md/i, expectDesc: "writes inside vault/journal/" },
  { label: "task-tracker / journal-Q", agent: "task-tracker", prompt: "what's in my journal?", expectRegex: /ask_agent\s*\(\s*["']journaler/i, expectDesc: 'declines + names journaler' },
  { label: "task-tracker / promote", agent: "task-tracker", prompt: "promote VOS-PROBE-1-fixture to active", expectRegex: /\/work\s+--queue\s+VOS-PROBE-1-fixture/i, expectDesc: "/work --queue VOS-PROBE-1-fixture" },
];

async function bootProbeDaemon(): Promise<{ app: Hono; vaultRoot: string; close: () => void }> {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vos-106-probe-"));
  cpSync(FIXTURE, vaultRoot, { recursive: true });

  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS);

  // Seed agent_cards from fixture starter-vault agent.md frontmatter.
  // For simplicity, hardcode the three known agents with their scopes.
  const seeds = {
    maya: { name: "maya", read_scope: ["vault/**"], write_scope: [] },
    journaler: { name: "journaler", read_scope: ["vault/journal/**"], write_scope: ["vault/journal/**"] },
    "task-tracker": { name: "task-tracker", read_scope: ["vault/work/**", "vault/journal/**"], write_scope: ["vault/work/**"] },
  };
  for (const [name, card] of Object.entries(seeds)) {
    db.run("INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)", [name, JSON.stringify(card)]);
  }

  const bus = createEventBus({ db });
  const bridge = createAskUserBridge({ db, bus });
  const engine = createPermissionEngine({ vaultRoot, homeRoot: process.env.HOME ?? "" });
  const daemonBase = `http://127.0.0.1:${process.env.PORT ?? "17777"}`;
  const repo = makeChatRepo(db);

  // Per-agent orchestrator (real claude-code provider).
  const orchByAgent = new Map<string, ReturnType<typeof makeOrchestrator>>();
  function orchFor(agent: string) {
    let o = orchByAgent.get(agent);
    if (o) return o;
    const provider = makeProvider(process.env as never, {
      bus, db, tracesDir: join(vaultRoot, ".traces"), agent, cwd: vaultRoot,
      engine, daemonBase, hookScriptPath: HOOK,
      loadAgentDefn: (n) => defaultLoadAgentDefn(db, n),
    });
    o = makeOrchestrator({ db, repo, provider, cwd: vaultRoot, emit: () => {}, titler: { title: async () => {} } });
    orchByAgent.set(agent, o);
    return o;
  }
  const routedOrch = {
    async dispatch(chatId: string, text: string) {
      const chat = repo.get(chatId);
      if (!chat) throw new Error(`chat not found: ${chatId}`);
      return orchFor(chat.agent).dispatch(chatId, text);
    },
    async cancel(chatId: string) {
      const chat = repo.get(chatId);
      if (!chat) return { cancelled: false, run_id: null };
      return orchFor(chat.agent).cancel(chatId);
    },
  };

  const app = new Hono();
  app.route("/", chatsApi(db));
  app.route("/", chatApi(db, { orchestrator: routedOrch }));
  mountMcp(app, { vaultRoot, db, bus, bridge, engine });
  mountAnswerRoute(app, { db, bridge });

  return { app, vaultRoot, close: () => db.close() };
}

async function runProbe(app: Hono, probe: Probe): Promise<{ pass: boolean; reply: string }> {
  const createRes = await app.request("/chats", {
    method: "POST",
    body: JSON.stringify({ agent: probe.agent }),
    headers: { "content-type": "application/json" },
  });
  const { id } = (await createRes.json()) as { id: string };

  const msgRes = await app.request(`/chat/${id}/message`, {
    method: "POST",
    body: JSON.stringify({ text: probe.prompt }),
    headers: { "content-type": "application/json" },
  });
  await msgRes.json();

  // Poll for terminal state, then fetch the reply.
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const r = await app.request(`/chat/${id}/messages`);
    const msgs = (await r.json()) as Array<{ role: string; parts: Array<{ text?: string }> }>;
    const last = msgs[msgs.length - 1];
    if (last && last.role === "agent") {
      const reply = last.parts.map((p) => p.text ?? "").join("");
      return { pass: probe.expectRegex.test(reply), reply };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { pass: false, reply: "<timeout>" };
}

async function main() {
  const { app, close } = await bootProbeDaemon();
  let strictPass = 0;
  const results: Array<{ probe: string; verdict: string; reply: string }> = [];
  for (const probe of PROBES) {
    try {
      const { pass, reply } = await runProbe(app, probe);
      const verdict = pass ? "PASS" : "FAIL";
      if (pass) strictPass++;
      results.push({ probe: probe.label, verdict, reply: reply.slice(0, 200) });
      console.log(`${verdict}  ${probe.label}\n  expected: ${probe.expectDesc}\n  reply: ${reply.slice(0, 200)}\n`);
    } catch (e) {
      results.push({ probe: probe.label, verdict: "PROBE_DESIGN_BUG", reply: String(e) });
      console.log(`PROBE_DESIGN_BUG  ${probe.label}: ${e}\n`);
    }
  }
  close();
  console.log(`\nSummary: ${strictPass}/${PROBES.length} strict pass`);
  if (strictPass < 5) {
    console.log("FAIL: <5/6 strict pass — acceptance gate not met.");
    process.exit(1);
  }
  console.log("PASS: ≥5/6 strict pass.");
}

await main();
```

- [ ] **Step 4: Write the probe README**

Create `daemon/test/probes/README.md`:

```markdown
# daemon/test/probes

End-to-end probes that spin a live in-process daemon and run **real** Claude
Code subprocesses via `claudev`. Not unit tests. Not part of `bun test`.
Run them explicitly:

    bun test:probes

## loader-integration.ts (VOS-106)

Six cross-agent routing probes against a fixture vault at
`daemon/test/fixtures/probe-vault/`. Pass when ≥5/6 strict-match the
expected behavior (the `expectRegex` per probe). The single permitted
non-pass is `PROBE_DESIGN_BUG` (harness error, not a routing regression).

Each probe creates a fresh chat for a starter-vault agent and asks a
question that exercises a cross-agent boundary. Expected behavior is that
the agent surfaces `ask_agent("<peer>", ...)` rather than reaching for
`Read` directly. The PreToolUse hook (VOS-106) is what makes this work —
without it, agents have full default tool access and bypass the routing.
```

- [ ] **Step 5: Add the `bun test:probes` script**

In `daemon/package.json`, add to `scripts`:

```json
    "test:probes": "bun run test/probes/loader-integration.ts"
```

- [ ] **Step 6: Smoke the harness without running probes**

Run: `cd workspace/void-os && bun run --check daemon/test/probes/loader-integration.ts`
Expected: typechecks (no execution).

- [ ] **Step 7: Commit fixture + harness**

```bash
git add daemon/test/fixtures/probe-vault/ daemon/test/probes/ daemon/package.json
git commit -m "task(VOS-106): T9 probe fixture vault + loader-integration harness"
```

---

## Task 10: Six-probe run + acceptance

**Files:**
- (no code changes — execution + log capture)
- Modify: `vault/work/tasks/active/VOS-106-*.md` work log (via `tools/state-write/sw`)

- [ ] **Step 1: Run the probe harness end-to-end**

Run:
```bash
cd workspace/void-os && bun run test/probes/loader-integration.ts 2>&1 | tee /tmp/vos-106-probe.log
```
Expected: `Summary: N/6 strict pass` with N ≥ 5. Exit code 0.

- [ ] **Step 2: On any FAIL — classify**

For each FAIL line:
1. If the reply text shows the agent reached for `Read`/`Glob`/`Bash` outside its scope → that's a **routing regression**. Inspect the hook env in the captured trace (`daemon/test/.traces/<runId>.settings.json`). Fix the hook or the scope before continuing.
2. If the reply shows the agent did the right thing but with slightly different phrasing (e.g. `ask_agent('journaler')` vs `ask_agent("journaler"`) → loosen the regex in the harness.
3. If the harness crashed → `PROBE_DESIGN_BUG`, not a routing failure. Allowed once per acceptance per spec §2.

- [ ] **Step 3: Append work log via `sw`**

Run (substitute the actual probe outcomes):

```bash
tools/state-write/sw "task(VOS-106): T10 six-probe run" -- bash -c '
set -e
cd /Users/admin/hub
f=$(ls vault/work/tasks/active/VOS-106-*.md | head -1)
cat >> "$f" <<EOF

### $(date -u +%Y-%m-%d) · T10 six-probe loader-integration
- harness: daemon/test/probes/loader-integration.ts
- result: <N>/6 strict pass (target ≥5)
- per-probe:
  - maya / journal-Q → <PASS|FAIL>
  - maya / next-work-Q → <PASS|FAIL>
  - journaler / mark-done → <PASS|FAIL>
  - journaler / log-session → <PASS|FAIL>
  - task-tracker / journal-Q → <PASS|FAIL>
  - task-tracker / promote → <PASS|FAIL>
- artifacts: /tmp/vos-106-probe.log
EOF
git add "$f"
'
```

- [ ] **Step 4: Commit no-op marker (probes are run, not committed)**

Skip — no source changes in this task. The work-log append in Step 3 is the only state mutation, and `sw` commits it on the canonical master.

---

## Task 11: Code review gate

**Files:** (no code changes)

- [ ] **Step 1: Dispatch a code review subagent**

Use `superpowers:requesting-code-review` with prompt:

> Review the full branch `task/VOS-106` in worktree `~/hub-wt/VOS-106/workspace/void-os/`. Spec: `docs/superpowers/specs/2026-05-16-vos-106-loader-integration-design.md`. Plan: `docs/superpowers/plans/2026-05-16-vos-106-loader-integration.md`. Six probe results: see VOS-106 task file `## Work Log` (T10 entry). Focus on:
> - Does the PreToolUse hook correctly gate every CC tool category (Read/Write/Edit/MultiEdit/Bash + Glob/Grep)?
> - Is the matcher truly shared between hook + engine (no duplicate picomatch logic)?
> - Does MCP URL-query identity flow correctly into `vault.read`?
> - Are there any spawn paths that bypass `buildSpawnSettings` (e.g. worker / skill / fake provider paths that legitimately need different wiring)?
> - Is the boot deny-probe robust to test injection?

- [ ] **Step 2: Address findings**

For each must-fix: cut a subagent dispatch with the precise change. For each nit: judgment call; cite the reasoning in the work log.

- [ ] **Step 3: Append review pass to work log**

```bash
tools/state-write/sw "task(VOS-106): T11 code review gate passed" -- bash -c '
set -e
cd /Users/admin/hub
f=$(ls vault/work/tasks/active/VOS-106-*.md | head -1)
cat >> "$f" <<EOF

### $(date -u +%Y-%m-%d) · T11 code review gate
- review: PASS over <commit-range>
- nits closed: <list>
- nits deferred: <list with reason>
EOF
git add "$f"
'
```

- [ ] **Step 4: Ready for `/done`**

All acceptance ticked. Prompt user: "All acceptance met. Run /done VOS-106?"

---

## Self-Review

Spec coverage:

- §2 acceptance bullet "resolves scopes at spawn time + writes into settings.json" → T6 (spawner inserts buildSpawnSettings call before argv build).
- §2 "cwd = vaultRoot + additionalDirectories" → T5 (spawn-settings filters in-vault paths out of additionalDirectories) + T6 (cwd is already `req.cwd` per existing spawner).
- §2 "PreToolUse denies Edit/Write/MultiEdit + Read/Glob/Grep + Bash" → T3 hook + T2 parser.
- §2 "--mcp-config wired" → T5 mcp.json + T6 argv extension.
- §2 "vault.read SCOPE_DENIED" → T8.
- §2 "six-probe ≥5/6" → T9 + T10.
- §2 "code review gate" → T11.
- §3.5 shared matcher → T1 + T4 fuzz.
- §3.7 deferred migration → no task, intentional.
- §4 hook fail-mode + boot deny-probe → T0 + T7.

Placeholder scan: no TODO / TBD / "handle edge cases" / "similar to Task N". Every code step has full code blocks. T10 step 3 has placeholder fields (`<N>`, `<PASS|FAIL>`) — these are intentional templates for the engineer to fill from the probe log, not unspecified design.

Type consistency check:
- `buildSpawnSettings({ agentName, scopes, systemDeny, vaultRoot, daemonBase, runId, settingsDir, hookScriptPath })` declared in T5 matches the call in T6.
- `ProviderDeps.engine: PermissionEngine` matches `CcSpawnerDeps.engine: PermissionEngine`.
- `loadAgentDefn: (name: string) => AgentDefn` consistent across factory + spawner + dispatch-child + mountMcp.
- `runBootDenyProbe({ hookScriptPath, spawnFn? })` signature matches in T7 test + impl + app.ts caller.
- `matchPath(absPath, patterns)` signature consistent: T1 def, T3 hook import, T1 engine refactor, T4 fuzz.

Plan complete and saved to `docs/superpowers/plans/2026-05-16-vos-106-loader-integration.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between, fast iteration. Required sub-skill: `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute in this session with `superpowers:executing-plans`, batch with checkpoints.

Which approach?
