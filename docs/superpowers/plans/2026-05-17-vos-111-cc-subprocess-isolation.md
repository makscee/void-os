# VOS-111 — CC Subprocess Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop spawned `claudev claude` subprocesses from inheriting the operator's `~/.claude/` config (plugins, MCP servers, slash commands, user settings). Replace inheritance with a deliberate vault-defined surface via three CC CLI flags.

**Architecture:** Three flags added to the existing argv built in `daemon/src/providers/claude-code/index.ts`: `--strict-mcp-config` (drops non-listed MCPs), `--setting-sources <pinned-form>` (drops `user` source — operator's settings.json), `--tools <ALLOWED_TOOLS>` (explicit built-in allowlist). New constants live in `spawn-settings.ts` alongside the existing per-run-settings builder. No env tampering — claudev's OAuth path and the PreToolUse hook keep working. T0 manual probe gates the implementation: it pins the exact `--setting-sources` value form, the MCP-tool name transform, and proves that `--settings <p>` is still honored when `--setting-sources` drops `user`.

**Tech Stack:** Bun + TypeScript, `claudev claude` (pinned via `daemon/package.json` `voidos.claudevVersion`), Bun test runner, fake-claudev shell fixture for integration, real claudev for opt-in smoke (`SMOKE=1`).

**Reference:** spec `docs/superpowers/specs/2026-05-17-vos-111-cc-subprocess-isolation-design.md`.

---

## Task 0: T0 manual probe — pre-implementation gate

**Purpose:** Pin three unknowns before any production code lands. The probe is committed (so it's repeatable across CC versions and operators). T1+ cannot begin until all three sub-assertions pass.

**Files:**
- Create: `daemon/test/probes/vos-111-isolation-probe.ts`
- Create: `daemon/test/probes/vos-111-isolation-probe.md` (runbook + recorded outputs)
- Modify: `daemon/test/probes/README.md` (link the new probe)
- Read: `daemon/package.json` (confirm pinned `voidos.claudevVersion`)
- Read: `docs/superpowers/specs/2026-05-17-vos-111-cc-subprocess-isolation-design.md` (§4 step 1)

### Sub-assertions the probe must prove

| # | Assertion | How to capture |
|---|---|---|
| A | `claudev claude --help` for the pinned version lists all three flags and the exact value form for `--setting-sources` is recorded. | Shell grep + paste raw `--help` line for `--setting-sources` into the runbook. |
| B | Exact MCP tool name CC emits for `vault.read` (registered as `vault.read` on McpServer `void-os`) is recorded. | Capture first `system` event after spawn, parse `tools` array, paste the literal string. |
| C | When spawned with `--strict-mcp-config --setting-sources <pinned> --settings <ours.json carrying PreToolUse hook>`, the PreToolUse hook fires on a tool call that should match the matcher. | Spawn with a deliberately-triggering `Bash` call in the prompt, capture stderr/trace for hook invocation evidence (a `PreToolUse` trace record or a denial). |

- [ ] **Step 1: Read pinned CC version**

Run: `cat /Users/admin/hub-wt/VOS-111/workspace/void-os/daemon/package.json | grep -A2 voidos`
Expected: a `voidos` block containing `"claudevVersion": "<x.y.z>"`. Record the version in the runbook header.

- [ ] **Step 2: Create the probe runbook with header**

Create `daemon/test/probes/vos-111-isolation-probe.md`:

```markdown
# VOS-111 isolation probe runbook

Pinned CC: claudev <version-from-package.json>
Pinned daemon commit: <fill at run time>
Operator: <fill at run time>
Date: 2026-05-17

## Sub-assertion A: flag syntax

Command:
```
claudev claude --help 2>&1 | grep -E 'strict-mcp-config|setting-sources|tools' | sed 's/^  *//'
```

Output (paste verbatim):
```
<paste here>
```

Recorded `--setting-sources` value form: `<single value | comma-list | repeated flag>`
Recorded pinned value: `<project | user,project,local | etc.>`

## Sub-assertion B: MCP tool name form

[fill after step 5]

## Sub-assertion C: --settings still honored under --setting-sources <pinned>

[fill after step 7]

## Outcome

- [ ] A passed (flag syntax recorded)
- [ ] B passed (MCP tool name form recorded)
- [ ] C passed (PreToolUse hook fired)

If any are FAIL → stop. Do not proceed to T1. Re-pin claudev version or revisit spec.
```

- [ ] **Step 3: Run flag-help grep (sub-assertion A)**

Run: `claudev claude --help 2>&1 | grep -E 'strict-mcp-config|setting-sources|tools' | sed 's/^  *//'`

Expected: three matches — the spec design assumed:
- `--strict-mcp-config` (no value)
- `--setting-sources <sources>` with help text like `Comma-separated list of setting sources to load (user, project, local).`
- `--tools <tools...>` with allowlist semantics

If any flag is missing on the pinned version: STOP. Bump `voidos.claudevVersion` to a version that has them, re-run the probe.

Paste output verbatim into runbook §A. Record the chosen `--setting-sources` value form. Default: pass `project` only (acceptance-driven). Document the literal flag form in the runbook (single-value vs comma-list).

- [ ] **Step 4: Write the probe driver (TypeScript)**

Create `daemon/test/probes/vos-111-isolation-probe.ts`:

```typescript
// VOS-111 manual isolation probe. NOT part of `bun test`. Run via:
//   bun daemon/test/probes/vos-111-isolation-probe.ts
//
// Pins three unknowns before VOS-111 T1 begins:
//   A — flag syntax for --setting-sources (operator runs Step 3 above first;
//       the chosen form is hard-coded here at the SETTING_SOURCES_FLAGS const).
//   B — exact MCP tool name CC emits for vault.read on McpServer void-os.
//   C — that --settings <p> is honored when --setting-sources drops user.
//
// The probe starts a minimal daemon-like Hono server that exposes the void-os
// MCP at /mcp (mounting the real adapter against an ephemeral SQLite + a
// vault root with one file), spawns claudev with the isolation flags, and
// captures CC's first `system` event.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server"; // or Bun.serve — match daemon/src
import { mountMcp } from "../../src/adapters/mcp/index.js";
import { openDatabase } from "../../src/adapters/sqlite/index.js";
// ... import the engine/loadAgentDefn the daemon uses, with permissive stubs
// scoped to the probe fixture dir.

// >>> Operator: set this to the form recorded in runbook §A.
//     Examples: ["--setting-sources", "project"]
//               ["--setting-sources", "project,local"]
//               ["--setting-sources", "project", "--setting-sources", "local"]
const SETTING_SOURCES_FLAGS: string[] = ["--setting-sources", "project"];

async function main() {
  // 1. Spin a probe daemon with a single MCP tool: vault.read against a
  //    minimal probe-vault containing one file (probe-vault/note.md).
  // 2. Build a settings.json that wires a PreToolUse hook for Bash and a
  //    permissions.deny: ["AskUserQuestion"] — matches what
  //    buildSpawnSettings emits. The hook writes a line to a probe-recorded
  //    file when fired (so we can observe it ran).
  // 3. Build an mcp.json pointing at the probe daemon's /mcp endpoint.
  // 4. Spawn `claudev claude -p "<prompt that issues one Bash call>"
  //                          --output-format stream-json --verbose
  //                          --strict-mcp-config
  //                          ...SETTING_SOURCES_FLAGS
  //                          --settings <p>
  //                          --mcp-config <p>`.
  //    No --tools yet — the probe wants to OBSERVE what leaks before we
  //    constrain. (T1 introduces --tools.)
  // 5. Parse stdout line-by-line until we see the first `{"type":"system",
  //    "subtype":"init", ...}` event. Extract `mcp_servers` and `tools`.
  // 6. Wait for the run to finish (or timeout 60s).
  // 7. Print three blocks:
  //      § B  mcp__void-os__* tool names found  -> paste into runbook §B
  //      § B  full tools array                  -> paste into runbook §B
  //      § C  hook-fired evidence (read the side-channel file written by
  //              the PreToolUse hook script)    -> paste into runbook §C
  //
  // EXACT IMPLEMENTATION:
  //   - Reuse buildSpawnSettings from spawn-settings.ts to write the two
  //     JSON files (so the probe matches production wire format).
  //   - Use `node:child_process` spawn (not Bun.spawn) so the probe can run
  //     standalone without a daemon boot.
  //   - Side-channel: write the PreToolUse hook script to a tmpfile that
  //     `echo "HOOK_FIRED $1" >> /tmp/probe-hook.log` and exit 0. After the
  //     spawn finishes, read probe-hook.log: presence of any line => C PASS.

  // ... [implementation details — fill in following the comments above]

  const probeDir = mkdtempSync(join(tmpdir(), "vos-111-probe-"));
  // ... (full implementation written by implementer following the outline)
}

main().catch((e) => { console.error(e); process.exit(1); });
```

The probe is committed even though parts are operator-filled, so subsequent operators can reproduce. The `SETTING_SOURCES_FLAGS` const at the top of the file IS the pinning point — operator edits it after Step 3.

- [ ] **Step 5: Run the probe (sub-assertion B + start of C)**

Run: `bun daemon/test/probes/vos-111-isolation-probe.ts`
Expected output blocks: `§ B mcp__void-os__* tool names found: ["mcp__void-os__vault_read", ...]` plus the full `tools` array.

Paste the verbatim `mcp_servers` and `tools` arrays into runbook §B. Specifically record:
- Exact MCP tool names → these become entries in `ALLOWED_TOOLS` (T1).
- Whether operator-installed MCPs (playwright, context7, plugin:context-mode) appear → with `--strict-mcp-config` they should NOT. If they do, the flag isn't doing what spec assumes; STOP.

- [ ] **Step 6: Inspect probe side-channel for hook fire (sub-assertion C)**

Run: `cat /tmp/probe-hook.log 2>/dev/null || echo "EMPTY"`
Expected: at least one `HOOK_FIRED Bash` line.

If EMPTY → sub-assertion C FAILS → the design's load-bearing claim (`--settings` independent of `--setting-sources`) is wrong. STOP, paste FAIL into runbook §C, surface to user; the design needs rework before T1.

If lines present → paste into runbook §C with timestamp. Tick §C.

- [ ] **Step 7: Tick runbook outcome boxes + commit**

Tick the three checkboxes at the bottom of `vos-111-isolation-probe.md`. Update `daemon/test/probes/README.md` to add a one-line entry pointing at the new probe.

Run:
```bash
git add daemon/test/probes/vos-111-isolation-probe.ts \
        daemon/test/probes/vos-111-isolation-probe.md \
        daemon/test/probes/README.md
git commit -m "test(VOS-111): T0 manual isolation probe + runbook outputs"
```

**T0 exit gate:** All three sub-assertions PASS, runbook committed. If any FAIL: do NOT start T1 — escalate to the user.

---

## Task 1: ALLOWED_TOOLS, ALLOWED_MCP_SERVERS, name transform — pure module

**Files:**
- Modify: `daemon/src/providers/claude-code/spawn-settings.ts`
- Modify: `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts`

- [ ] **Step 1: Write the failing test (constants + transform)**

Add to `daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts`:

```typescript
import {
  ALLOWED_TOOLS,
  ALLOWED_MCP_SERVERS,
  mcpToolNameFor,
} from "../spawn-settings.js";

describe("VOS-111: tool allowlist + name transform", () => {
  test("ALLOWED_TOOLS contains the pinned built-ins + void-os MCP tools", () => {
    expect(ALLOWED_TOOLS).toEqual([
      "Bash",
      "Edit",
      "MultiEdit",
      "Read",
      "Write",
      "Grep",
      "Glob",
      "NotebookEdit",
      "NotebookRead",
      "TodoWrite",
      "WebFetch",
      "WebSearch",
      "mcp__void-os__vault_read",
      "mcp__void-os__ask_user",
      "mcp__void-os__ask_agent",
    ]);
  });

  test("ALLOWED_TOOLS is readonly + frozen", () => {
    expect(Object.isFrozen(ALLOWED_TOOLS)).toBe(true);
  });

  test("ALLOWED_MCP_SERVERS lists void-os only", () => {
    expect(ALLOWED_MCP_SERVERS).toEqual(["void-os"]);
    expect(Object.isFrozen(ALLOWED_MCP_SERVERS)).toBe(true);
  });

  test("mcpToolNameFor: dotted registered name -> CC-emitted name", () => {
    expect(mcpToolNameFor("void-os", "vault.read")).toBe("mcp__void-os__vault_read");
    expect(mcpToolNameFor("void-os", "ask_user")).toBe("mcp__void-os__ask_user");
    expect(mcpToolNameFor("void-os", "ask_agent")).toBe("mcp__void-os__ask_agent");
    // Confirm `.` -> `_` and nothing else.
    expect(mcpToolNameFor("void-os", "a.b.c")).toBe("mcp__void-os__a_b_c");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test src/providers/claude-code/__tests__/spawn-settings.test.ts -t "VOS-111"`
Expected: FAIL with `ALLOWED_TOOLS is not exported` / `mcpToolNameFor is not exported`.

- [ ] **Step 3: Implement constants + transform in `spawn-settings.ts`**

Add to the top of `daemon/src/providers/claude-code/spawn-settings.ts`, after the existing imports:

```typescript
// VOS-111: agent isolation surface.
//
// The spawned CC subprocess must NOT load operator-personal config from
// ~/.claude/. The three flags in index.ts (--strict-mcp-config,
// --setting-sources, --tools) carry the constants below.
//
// MCP tool names: CC exposes registered MCP tools as
// `mcp__<server>__<tool>` with `.` rewritten to `_`. The exact form was
// pinned by VOS-111 T0 — see daemon/test/probes/vos-111-isolation-probe.md.

export function mcpToolNameFor(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/\./g, "_")}`;
}

export const ALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Bash",
  "Edit",
  "MultiEdit",
  "Read",
  "Write",
  "Grep",
  "Glob",
  "NotebookEdit",
  "NotebookRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  mcpToolNameFor("void-os", "vault.read"),
  mcpToolNameFor("void-os", "ask_user"),
  mcpToolNameFor("void-os", "ask_agent"),
]);

export const ALLOWED_MCP_SERVERS: readonly string[] = Object.freeze(["void-os"]);

// Pinned by T0 — record the exact flag form here. The default (single value
// `project`) reflects what the spec assumes; if T0 found a different form,
// update both the value and the comment with a pointer to the runbook entry.
export const SETTING_SOURCES_ARGS: readonly string[] = Object.freeze([
  "--setting-sources",
  "project",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test src/providers/claude-code/__tests__/spawn-settings.test.ts -t "VOS-111"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/providers/claude-code/spawn-settings.ts \
        daemon/src/providers/claude-code/__tests__/spawn-settings.test.ts
git commit -m "feat(VOS-111): ALLOWED_TOOLS + ALLOWED_MCP_SERVERS + mcpToolNameFor"
```

---

## Task 2: Wire isolation flags into spawner argv

**Files:**
- Modify: `daemon/src/providers/claude-code/index.ts` (the `args` array ~L269)
- Modify: `daemon/test/cc-spawner.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add at the end of `daemon/test/cc-spawner.integration.test.ts`, inside the existing `describe("CC spawner (fake claudev)", ...)` block:

```typescript
test("VOS-111: argv includes --strict-mcp-config, --setting-sources, --tools <allowlist>", async () => {
  const { dir, db, bus, tracesDir } = setup();
  const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE, ...stubDeps() });
  let proc: Awaited<ReturnType<typeof spawner.spawn>> | undefined;
  const stderrChunks: string[] = [];

  // The integration tests subscribe to cc.event records; the fake echoes argv
  // to stderr. spawner pipes stderr through the trace, so the easiest route
  // is to read the trace after the run.
  try {
    proc = await spawner.spawn({
      prompt: "--scenario happy",
      agent: "test",
      cwd: dir,
    });
    await proc.wait();
  } finally {
    teardown(dir, db);
  }

  // Read the trace file for the run, pull stderr records, assert argv contents.
  const traceRow = db.prepare(
    "SELECT trace_path FROM runs WHERE id=?",
  ).get(proc!.runId) as { trace_path: string };
  const { records } = await readTrace(traceRow.trace_path);
  const argvLine = records
    .map((r) => JSON.stringify(r))
    .find((s) => s.includes("fake-claudev argv:"));
  expect(argvLine).toBeDefined();

  // Assertions on the argv echoed by fake-claudev.
  expect(argvLine!).toContain("--strict-mcp-config");
  expect(argvLine!).toContain("--setting-sources");
  expect(argvLine!).toContain("project");
  expect(argvLine!).toContain("--tools");
  // Allowlist joined with commas — match a recognizable slice.
  expect(argvLine!).toContain("Bash,Edit,MultiEdit,Read,Write");
  expect(argvLine!).toContain("mcp__void-os__vault_read");
});
```

(If `readTrace` is sync in this repo, drop the `await` — match the pattern of the sibling test on L105-110 of this file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/cc-spawner.integration.test.ts -t "VOS-111"`
Expected: FAIL — argv does not include `--strict-mcp-config`.

- [ ] **Step 3: Wire flags into the spawner argv**

In `daemon/src/providers/claude-code/index.ts`, the `args` array sits at ~L269. Replace it with:

```typescript
const args = [
  "-p", req.prompt,
  "--output-format", "stream-json",
  "--verbose",
  "--strict-mcp-config",
  ...SETTING_SOURCES_ARGS,
  "--tools", ALLOWED_TOOLS.join(","),
  "--settings", settingsPath,
  "--mcp-config", mcpConfigPath,
  ...(persona.body ? ["--append-system-prompt", persona.body] : []),
  ...(req.resumeFrom ? ["--resume", req.resumeFrom] : []),
];
```

Add the import at the top of the file (with the existing `buildSpawnSettings` import):

```typescript
import {
  buildSpawnSettings,
  ALLOWED_TOOLS,
  SETTING_SOURCES_ARGS,
} from "./spawn-settings.ts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/cc-spawner.integration.test.ts -t "VOS-111"`
Expected: PASS.

- [ ] **Step 5: Run the full CC-spawner integration suite to confirm no regressions**

Run: `cd daemon && bun test test/cc-spawner.integration.test.ts`
Expected: all tests PASS — the new flags must not break happy/tool-call/resume/timeout/crash scenarios. fake-claudev ignores unknown flags (it loops over `case "$1"` and `*) shift`), so this should be a no-op for the other scenarios.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/providers/claude-code/index.ts \
        daemon/test/cc-spawner.integration.test.ts
git commit -m "feat(VOS-111): wire --strict-mcp-config + --setting-sources + --tools into spawner"
```

---

## Task 3: Forward-drift guard test

**Purpose:** prevent the regression where someone registers a new void-os MCP tool but forgets to add it to `ALLOWED_TOOLS`. Test enumerates the live MCP server's registered tools, applies the transform, asserts each is in `ALLOWED_TOOLS`.

**Files:**
- Create: `daemon/test/mcp-allowlist-drift.test.ts`

- [ ] **Step 1: Write the failing test**

Create `daemon/test/mcp-allowlist-drift.test.ts`:

```typescript
// VOS-111: forward-drift guard. Asserts every MCP tool the void-os MCP
// server registers is also exposed to spawned agents via ALLOWED_TOOLS.
// If you add a new MCP tool and this test fails: add the corresponding
// `mcp__void-os__<tool>` entry to ALLOWED_TOOLS in spawn-settings.ts.

import { describe, expect, test } from "bun:test";
import {
  ALLOWED_TOOLS,
  mcpToolNameFor,
} from "../src/providers/claude-code/spawn-settings.js";
import { buildMcpServer } from "../src/adapters/mcp/index.js"; // export name TBD — see step 3

describe("VOS-111: MCP tool allowlist drift guard", () => {
  test("every registered void-os MCP tool is in ALLOWED_TOOLS", async () => {
    // Build the MCP server with permissive stubs so we can enumerate
    // registered tools without booting the daemon.
    const server = buildMcpServer({
      db: {} as never,
      vaultRoot: "/tmp",
      engine: {} as never,
      bridge: {} as never,
      bus: { emit: () => {} } as never,
      loadAgentDefn: () => ({ name: "test" }) as never,
      dispatchChildTask: async () => {},
      callingAgent: "test",
    });
    // McpServer exposes the underlying registered tools via .tools() in the
    // SDK. If that API differs in the pinned SDK version, fall back to
    // grepping the source — but prefer the runtime enumeration so the test
    // can't go stale.
    const registered: string[] = Array.from(server._registeredTools?.keys?.() ?? []);
    expect(registered.length).toBeGreaterThan(0);
    for (const tool of registered) {
      const exposed = mcpToolNameFor("void-os", tool);
      expect(ALLOWED_TOOLS).toContain(exposed);
    }
  });
});
```

(`_registeredTools` is the MCP SDK's internal map name in v1.20.x. If the SDK exposes a public `.listTools()` or similar, prefer that. Step 3 reconciles.)

- [ ] **Step 2: Run test — likely fails on import**

Run: `cd daemon && bun test test/mcp-allowlist-drift.test.ts`
Expected: FAIL on `buildMcpServer` import (the adapter file does not currently export the builder by that name; it returns from `mountMcp`'s inner construction).

- [ ] **Step 3: Export the MCP server builder from `adapters/mcp/index.ts`**

Inspect `daemon/src/adapters/mcp/index.ts` lines around `new McpServer({ name: "void-os", ... })`. Lift that construction into an exported `buildMcpServer(deps)` function (returns the `McpServer` instance, not `.server`). The existing `mountMcp` continues to call this internally and read `.server` from it.

Concretely, refactor the existing block:

```typescript
// before
const mcp = new McpServer({ name: "void-os", version: pkg.version });
mcp.registerTool("vault.read", vaultReadDef, makeVaultRead({...}) as never);
mcp.registerTool("ask_user", askUserDef, makeAskUser({...}) as never);
mcp.registerTool("ask_agent", askAgentDef, makeAskAgent({...}) as never);
return mcp.server;
```

```typescript
// after
export function buildMcpServer(deps: BuildMcpServerDeps): McpServer {
  const mcp = new McpServer({ name: "void-os", version: pkg.version });
  mcp.registerTool("vault.read", vaultReadDef, makeVaultRead(deps) as never);
  mcp.registerTool("ask_user", askUserDef, makeAskUser({ bridge: deps.bridge }) as never);
  mcp.registerTool("ask_agent", askAgentDef, makeAskAgent({
    db: deps.db, bus: deps.bus, loadAgentDefn: deps.loadAgentDefn,
    dispatchChildTask: deps.dispatchChildTask,
    now: () => Date.now(), emit: deps.emit,
  }) as never);
  return mcp;
}

// existing mountMcp internally:
//   const mcp = buildMcpServer({...});
//   ... mcp.server is used as before
```

`BuildMcpServerDeps` mirrors the existing inline deps. Name carefully so existing callers don't move.

- [ ] **Step 4: Re-run drift test**

Run: `cd daemon && bun test test/mcp-allowlist-drift.test.ts`
Expected: PASS — all three registered tools (`vault.read`, `ask_user`, `ask_agent`) map cleanly into `ALLOWED_TOOLS`.

If the test cannot find `._registeredTools` on the SDK version: adjust the enumeration to whatever the SDK exposes (check `node_modules/@modelcontextprotocol/sdk/dist/.../mcp.d.ts`). Worst-case: hardcode the three names in the test and add a comment, since the registration call sites are right there in `buildMcpServer`. The drift test still works — it just leans on grep over the source rather than runtime introspection.

- [ ] **Step 5: Run the full MCP test set to confirm no regressions**

Run: `cd daemon && bun test test/mcp*.test.ts test/mcp-allowlist-drift.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/adapters/mcp/index.ts daemon/test/mcp-allowlist-drift.test.ts
git commit -m "test(VOS-111): forward-drift guard for MCP tool allowlist"
```

---

## Task 4: Smoke test — real-claudev subset assertions

**Files:**
- Modify: `daemon/test/smoke.test.ts`

**Context:** the existing smoke is gated on `SMOKE=1`. It spawns real claudev against an ephemeral daemon and parses a marker reply. The VOS-111 extension parses the first `system` event from CC's stream-json output and asserts subset semantics on `mcp_servers` + `tools`.

- [ ] **Step 1: Read the existing smoke test**

Run: `cat daemon/test/smoke.test.ts | head -120`
Confirm the existing structure: ephemeral daemon, `claudev claude ... --mcp-config ...` spawn, line-buffered stdout parse, marker assertion at the end.

- [ ] **Step 2: Add the subset-assertion test alongside the existing one**

Append to `daemon/test/smoke.test.ts` inside the existing `describe` block (or add a sibling `describe.if(process.env.SMOKE === "1")(...)`):

```typescript
test.if(process.env.SMOKE === "1")(
  "VOS-111: spawned CC sees only ALLOWED_MCP_SERVERS and ALLOWED_TOOLS",
  async () => {
    // Reuse the existing smoke harness: it already spawns claudev with our
    // --mcp-config and pipes stream-json on stdout. We need to:
    //   1. Wait for the first `{"type":"system","subtype":"init",...}` line.
    //   2. Parse it, pull `mcp_servers` and `tools`.
    //   3. Assert subset semantics.
    //
    // The spawner production code now adds --strict-mcp-config,
    // --setting-sources project, and --tools <ALLOWED_TOOLS>. The smoke
    // exercises the real code path, so we don't add those flags here —
    // we observe them taking effect.

    const sys = await waitForSystemInit(child.stdout); // helper extracted in step 3
    const mcpServers: string[] = (sys.mcp_servers ?? []).map((s: any) => s.name ?? s);
    const tools: string[] = sys.tools ?? [];

    expect(mcpServers.length).toBeGreaterThan(0);
    for (const server of mcpServers) {
      expect(ALLOWED_MCP_SERVERS).toContain(server);
    }
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(ALLOWED_TOOLS).toContain(tool);
    }
  },
);
```

Add at the top of the file:
```typescript
import {
  ALLOWED_TOOLS,
  ALLOWED_MCP_SERVERS,
} from "../src/providers/claude-code/spawn-settings.js";
```

- [ ] **Step 3: Extract `waitForSystemInit(stream)` helper**

In `daemon/test/smoke.test.ts`, lift the line-buffered stdout parse from the existing test into a helper:

```typescript
async function waitForSystemInit(
  stdout: NodeJS.ReadableStream,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("system.init timeout")), timeoutMs);
    let buf = "";
    stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const j = JSON.parse(line);
          if (j.type === "system" && j.subtype === "init") {
            clearTimeout(t);
            resolve(j);
            return;
          }
        } catch { /* not JSON, skip */ }
      }
    });
    stdout.on("end", () => { clearTimeout(t); reject(new Error("stdout ended before system.init")); });
  });
}
```

The existing happy-path smoke test refactors to use it too (read the first system event, then continue parsing for the marker reply). One-call-site change; if the diff feels big, leave the existing test as-is and only the new test uses the helper.

- [ ] **Step 4: Run smoke locally (opt-in)**

Run: `cd daemon && SMOKE=1 bun test test/smoke.test.ts -t "VOS-111"`
Expected: PASS. Cost: a few cents on the operator's claudev pool token.

Inspect the captured `mcp_servers` + `tools` from the smoke output — eyeball that no `playwright` / `context7` / `plugin:context-mode` / `Task` / `EnterPlanMode` appears.

If the smoke FAILS with `mcp_servers` containing something other than `void-os`: T0 sub-assertion B was wrong, or `--strict-mcp-config` doesn't behave as the spec assumed. Halt; revisit the design.

- [ ] **Step 5: Run the existing happy-path smoke to verify no regression**

Run: `cd daemon && SMOKE=1 bun test test/smoke.test.ts`
Expected: existing marker-reply test still PASSES.

- [ ] **Step 6: Commit**

```bash
git add daemon/test/smoke.test.ts
git commit -m "test(VOS-111): smoke subset-asserts mcp_servers + tools against allowlist"
```

---

## Task 5: Vault project-settings audit log

**Purpose:** spec §5 risk #1. `--setting-sources project` still loads `<vault>/.claude/settings.json` if such a file exists. Log a warning at daemon boot when one is present so operators know what's being loaded; do not block.

**Files:**
- Modify: `daemon/src/app.ts` (or wherever the daemon boot wires logging)
- Create: `daemon/test/app-wiring.vos-111.test.ts` (or extend the existing wiring test if one exists)

- [ ] **Step 1: Locate the boot/init site**

Run: `grep -n "vaultRoot\|VAULT_ROOT" daemon/src/app.ts daemon/src/index.ts daemon/src/boot/*.ts 2>/dev/null | head`
Expected: a single spot where the daemon resolves the vault root at startup. Note the file + line.

- [ ] **Step 2: Write the failing test**

Create or extend a wiring test at `daemon/test/app-wiring.vos-111.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditVaultProjectSettings } from "../src/boot/audit-project-settings.js";

describe("VOS-111: vault project-settings audit", () => {
  test("logs a warning when <vaultRoot>/.claude/settings.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "vos-111-audit-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "settings.json"), "{}");
      const logged: string[] = [];
      auditVaultProjectSettings(dir, (msg) => logged.push(msg));
      expect(logged.length).toBe(1);
      expect(logged[0]).toContain(".claude/settings.json");
      expect(logged[0]).toContain("loaded by --setting-sources project");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("silent when no project settings file present", () => {
    const dir = mkdtempSync(join(tmpdir(), "vos-111-audit-"));
    try {
      const logged: string[] = [];
      auditVaultProjectSettings(dir, (msg) => logged.push(msg));
      expect(logged).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test — fails on import**

Run: `cd daemon && bun test test/app-wiring.vos-111.test.ts`
Expected: FAIL — `auditVaultProjectSettings` not exported.

- [ ] **Step 4: Implement the audit helper**

Create `daemon/src/boot/audit-project-settings.ts`:

```typescript
// VOS-111: when --setting-sources project is set, CC still loads
// <vaultRoot>/.claude/settings.json if present. Log at boot so operators
// see what's effectively trusted; do not block (vault-authored project
// settings are intentional).

import { existsSync } from "node:fs";
import { join } from "node:path";

export function auditVaultProjectSettings(
  vaultRoot: string,
  log: (msg: string) => void = console.warn,
): void {
  const p = join(vaultRoot, ".claude", "settings.json");
  if (existsSync(p)) {
    log(
      `[VOS-111] vault project settings present at ${p} — loaded by --setting-sources project. ` +
      `Audit this file: any hooks, permissions, or enabledMcpjsonServers entries influence every spawned agent.`,
    );
  }
}
```

- [ ] **Step 5: Wire the audit into daemon boot**

In the boot site found in step 1, after `vaultRoot` is resolved and before the first spawn can occur, add:

```typescript
import { auditVaultProjectSettings } from "./boot/audit-project-settings.js";
// ...
auditVaultProjectSettings(vaultRoot);
```

- [ ] **Step 6: Run tests**

Run: `cd daemon && bun test test/app-wiring.vos-111.test.ts`
Expected: both tests PASS.

Run: `cd daemon && bun test test/app-wiring.test.ts` (existing wiring test, if any)
Expected: still PASSES.

- [ ] **Step 7: Commit**

```bash
git add daemon/src/boot/audit-project-settings.ts \
        daemon/test/app-wiring.vos-111.test.ts \
        daemon/src/app.ts
git commit -m "feat(VOS-111): boot-time audit log for vault .claude/settings.json"
```

(Adjust the modified file path in `git add` to whatever step 1 identified.)

---

## Task 6: VOS-107 e2e scan + minor adjustments

**Purpose:** acceptance bullet 5. Scan VOS-107 e2e specs (and the manual-e2e doc) for assertions that relied on the pre-fix leaky tool/MCP listing.

**Files:**
- Read: `daemon/test/manual-e2e.md`
- Read: any `*.spec.ts` in `daemon/test/` referencing VOS-107
- Modify: any of the above that asserts e.g. `playwright` in `mcp_servers` or `Task` in `tools`

- [ ] **Step 1: Grep for leaky assertions**

Run: `grep -rn "playwright\|context7\|plugin:context-mode\|EnterPlanMode\|CronCreate\|RemoteTrigger\|ScheduleWakeup" daemon/test/ docs/superpowers/specs/ | grep -v "VOS-111" | head -40`
Expected: a small list of hits. Most will be inside the VOS-111 spec itself (filtered out by the grep). Anything else is a candidate for review.

- [ ] **Step 2: Categorize hits**

For each match: is it (a) an assertion that the leak was present (REMOVE — was the bug), (b) an explanatory comment about what was leaking pre-fix (KEEP — historical), or (c) a runbook step the operator should update (UPDATE — replace with the new expected listing)?

Record categorization in the commit message.

- [ ] **Step 3: Apply changes**

Edit each (a)/(c) hit. Common patterns:
- A test that expected `mcp_servers` to include something other than `void-os` → drop that expectation, replace with `expect(mcpServers).toEqual(["void-os"])` or with the subset assertion already used in Task 4.
- A runbook expecting `tools` to include `Task` → strike, document that as a regression check.

- [ ] **Step 4: Run the affected test files**

For each test file touched: `cd daemon && bun test <path>`. Expected: PASS.

- [ ] **Step 5: Commit (skip if no hits)**

```bash
git add <files>
git commit -m "test(VOS-111): drop pre-fix leaky-tool/MCP expectations from VOS-107 e2e"
```

If step 1 returned no actionable hits, skip the commit and note in the task work log that the scan turned up no leaky assertions.

---

## Task 7: Final manual verify + tick task acceptance

**Files:**
- Read: trace from a real spawn
- Modify (state-plane via `sw_run`): `vault/work/tasks/active/VOS-111-*.md` — tick acceptance boxes

- [ ] **Step 1: Spawn one real agent run end-to-end**

Start the daemon, dispatch a maya turn (or whatever lightweight agent is available against the live vault), capture its trace.

```bash
# Run the daemon (operator-specific incantation; the existing manual-e2e doc has it)
# Then dispatch one short prompt.
```

- [ ] **Step 2: Inspect the trace's first system event**

Find the run's trace file (sqlite `runs.trace_path`), open it, locate the `cc.event` whose payload is `{"type":"system","subtype":"init",...}`. Confirm:

| Check | Expected |
|---|---|
| `mcp_servers` | contains exactly `{name: "void-os"}` (or the SDK's equivalent shape) |
| `tools` | every entry is in `ALLOWED_TOOLS`; no `Task`, `EnterPlanMode`, `ScheduleWakeup`, etc. |

If pass: proceed. If fail: do NOT tick acceptance — debug. The integration + smoke tests should have caught this; if they passed but real run fails, the smoke harness is too permissive — flag for follow-up.

- [ ] **Step 3: Tick acceptance via `sw_run` on the task file**

```bash
tools/state-write/sw "task(VOS-111): acceptance ticked" -- bash -c '
  set -e
  cd /Users/admin/hub
  f=$(ls vault/work/tasks/active/VOS-111-*.md | head -1)
  python3 -c "
import re, pathlib
p = pathlib.Path(\"$f\")
s = p.read_text()
# Tick every [ ] in the Acceptance section.
def tick(m): return m.group(0).replace(\"[ ]\", \"[x]\")
s = re.sub(r\"^- \\[ \\].*\", tick, s, flags=re.M)
p.write_text(s)
"
  git add "$f"
'
```

- [ ] **Step 4: Append work-log session entry via `sw_run`**

```bash
tools/state-write/sw "task(VOS-111): work-log final verify" -- bash -c '
  set -e
  cd /Users/admin/hub
  f=$(ls vault/work/tasks/active/VOS-111-*.md | head -1)
  cat >> "$f" <<EOF

### $(date -u +%Y-%m-%d) · final verify
- Real-spawn trace inspected: mcp_servers={void-os}, tools ⊆ ALLOWED_TOOLS
- Acceptance ticked
- Ready for /done
EOF
  git add "$f"
'
```

- [ ] **Step 5: Prompt user for /done**

Print: `All acceptance criteria met. Run /done VOS-111?`

---

## Self-Review (run after writing the plan)

**1. Spec coverage:**

| Spec section | Plan task |
|---|---|
| §Mechanism — three flags | T2 (wire) |
| §Allowlist — constants pinned | T1 (define + test) |
| §Change surface — spawn-settings + index | T1, T2 |
| §Test strategy step 1 (T0 probe, three sub-assertions) | T0 |
| §Test strategy step 2 (unit pin) | T1 |
| §Test strategy step 3 (integration argv) | T2 |
| §Test strategy step 4 (smoke subset) | T4 |
| §Test strategy step 5 (VOS-107 scan) | T6 |
| §Test strategy step 6 (forward-drift guard) | T3 |
| §Risk 1 — vault project-settings audit | T5 |
| §Risk 2 — name form pinned via T0 | T0 + T1 |
| §Risk 3 — drift handled | T3 |
| Acceptance ticks (task file) | T7 |

No gaps.

**2. Placeholder scan:**

- "Operator-specific incantation; the existing manual-e2e doc has it" (T7 step 1) — explicit pointer, not a TBD. Acceptable.
- T0 step 4 probe driver has an `// ... [implementation details — fill in following the comments above]` block. This is the operator's hand-fill point; the comments above it are the complete spec. Acceptable for a probe, but flag explicitly so a subagent doesn't skip it.
- T5 step 7 `git add daemon/src/app.ts` — actual path comes from step 1's grep. Documented.

**3. Type consistency:**

- `ALLOWED_TOOLS` (T1, T2, T3, T4) — consistent name throughout.
- `ALLOWED_MCP_SERVERS` (T1, T4) — consistent.
- `mcpToolNameFor` (T1, T3) — consistent.
- `SETTING_SOURCES_ARGS` (T1, T2) — consistent.
- `auditVaultProjectSettings` (T5) — consistent.
- `buildMcpServer` (T3 introduces it) — consistent with its single call site in `mountMcp`.
- `waitForSystemInit` (T4) — consistent.

No drift.

---

## Execution choice

After plan acceptance, choose:

1. **Subagent-Driven** (recommended) — orchestrator (this session) dispatches one subagent per task; reviews diffs between tasks. Fast iteration, isolated context per task. T0 dispatched first as a blocking gate; T1/T2 serial (T2 depends on T1's exports); T3/T5 can parallelize; T4 after T2 (smoke needs live wiring); T6 after T4 (knows the new expected listing); T7 last.

2. **Inline Execution** — operator drives each task in this session via `executing-plans`.
