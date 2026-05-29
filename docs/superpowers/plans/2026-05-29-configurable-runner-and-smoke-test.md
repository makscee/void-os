# Configurable Claude Code Runner + smoke-test Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator choose which command runs Claude Code (default in `void-os.json`, overridable per session via a dashboard dropdown), and replace the `TEST:` hack with a dedicated cheap `smoke-test` skill.

**Architecture:** A runner is a `{label, command}` pair where `command` is an argv **prefix** (`vc --` or `claude_artem`) tokenized on whitespace and prepended to the claude-side args. Config lives in the existing `void-os.json`. The chosen runner is persisted per session in `session-meta.json` so resume reuses it.

**Tech Stack:** Bun + TypeScript + Hono. Tests via `bun test`. Spec: `docs/superpowers/specs/2026-05-29-configurable-runner-and-smoke-test-design.md`.

**Branch:** stacks on `task/VOS-181` (tip `0e26762`). Do NOT branch from `main` — this removes the `TEST:` hack that exists only on the VOS-181 branch and edits the same files.

---

## File Structure

- `src/paths.ts` — add `Runner` interface, `runners`/`defaultRunner` on `VoidOsConfig`, defaults + back-compat in `readConfig`, new `resolveRunner()`.
- `src/spawn.ts` — drop `--` from the two argv builders; add `tokenizeCommand()`; add `command` param to `spawnTurn()`.
- `src/server.ts` — `/launch` resolves + persists runner; `/s/:uuid/send` reads it back from `session-meta.json`.
- `src/render.ts` — `renderDashboard` gains a runner config; renders the "Run as" `<select>` + hidden `runner` inputs + sync script.
- `src/init.ts` — no logic change needed (seeding is automatic via `readConfig`→`writeConfig`); add a test that locks it.
- `catalog/skills/smoke-test/SKILL.md` — new cheap full-loop skill.
- `catalog/skills/deep-research/SKILL.md` — remove the `TEST:` block.
- `~/.claude/projects/-Users-admin-hub/memory/feedback_cheap_test_mode_for_expensive_skills.md` + `MEMORY.md` — rewrite to point at `smoke-test`.
- Tests: `tests/paths.test.ts`, `tests/spawn.test.ts`, `tests/server.test.ts`, `tests/render.test.ts`, `tests/init.test.ts`.

---

## Task 1: Config — Runner type, back-compat, resolveRunner

**Files:**
- Modify: `src/paths.ts`
- Test: `tests/paths.test.ts`

- [ ] **Step 1: Write failing tests** — append to `tests/paths.test.ts`:

```ts
import { readConfig, writeConfig, resolveRunner, DEFAULT_RUNNER_LABEL } from "../src/paths.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("readConfig defaults runners to vc when absent", () => {
  const v = mkdtempSync(join(tmpdir(), "vos-cfg-"));
  const cfg = readConfig(v); // no void-os.json yet
  expect(cfg.runners).toEqual([{ label: "vc (relay)", command: "vc --" }]);
  expect(cfg.defaultRunner).toBe(DEFAULT_RUNNER_LABEL);
});

test("readConfig back-compat: existing config without runners gets vc default", () => {
  const v = mkdtempSync(join(tmpdir(), "vos-cfg-"));
  writeFileSync(join(v, "void-os.json"), JSON.stringify({ vault: v, onboarded: true, skills: [], answers: {}, port: 4317 }));
  const cfg = readConfig(v);
  expect(cfg.runners[0].command).toBe("vc --");
  expect(cfg.defaultRunner).toBe("vc (relay)");
});

test("resolveRunner returns matching command, falls back to default on unknown/missing", () => {
  const cfg = { vault: "/x", onboarded: true, skills: [], answers: {}, port: 4317,
    runners: [{ label: "vc (relay)", command: "vc --" }, { label: "artem", command: "claude_artem" }],
    defaultRunner: "vc (relay)" };
  expect(resolveRunner(cfg, "artem")).toBe("claude_artem");
  expect(resolveRunner(cfg, "nope")).toBe("vc --");
  expect(resolveRunner(cfg)).toBe("vc --");
});
```

- [ ] **Step 2: Run to verify fail** — `cd workspace/void-os && bun test tests/paths.test.ts` → FAIL (`resolveRunner` not exported, `runners` undefined).

- [ ] **Step 3: Implement** — in `src/paths.ts`, add the `Runner` interface, extend `VoidOsConfig`, add defaults, update `readConfig`, add `resolveRunner`:

```ts
export interface Runner {
  label: string;
  command: string; // argv prefix, tokenized on whitespace (e.g. "vc --" or "claude_artem")
}

export interface VoidOsConfig {
  vault: string;
  onboarded: boolean;
  skills: string[];
  answers: Record<string, string>;
  port: number;
  runners: Runner[];
  defaultRunner: string;
}

const DEFAULT_PORT = 4317;
export const DEFAULT_RUNNER_LABEL = "vc (relay)";
export const DEFAULT_RUNNERS: Runner[] = [{ label: DEFAULT_RUNNER_LABEL, command: "vc --" }];

export function readConfig(vault: string): VoidOsConfig {
  const p = configPath(vault);
  if (!existsSync(p)) {
    return { vault, onboarded: false, skills: [], answers: {}, port: DEFAULT_PORT,
      runners: DEFAULT_RUNNERS, defaultRunner: DEFAULT_RUNNER_LABEL };
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<VoidOsConfig>;
  const runners = raw.runners && raw.runners.length ? raw.runners : DEFAULT_RUNNERS;
  return {
    vault: raw.vault ?? vault,
    onboarded: raw.onboarded ?? false,
    skills: raw.skills ?? [],
    answers: raw.answers ?? {},
    port: raw.port ?? DEFAULT_PORT,
    runners,
    defaultRunner: raw.defaultRunner ?? runners[0].label,
  };
}

/** Resolve a runner label to its command prefix; falls back to defaultRunner (then first). */
export function resolveRunner(cfg: VoidOsConfig, label?: string): string {
  const byLabel = label ? cfg.runners.find((r) => r.label === label) : undefined;
  if (byLabel) return byLabel.command;
  const def = cfg.runners.find((r) => r.label === cfg.defaultRunner);
  return (def ?? cfg.runners[0]).command;
}
```

- [ ] **Step 4: Run to verify pass** — `bun test tests/paths.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat(VOS-182): runner config + resolveRunner with vc back-compat"
```

---

## Task 2: argv refactor — drop `--`, tokenizeCommand, spawnTurn command param

**Files:**
- Modify: `src/spawn.ts`
- Test: `tests/spawn.test.ts`

- [ ] **Step 1: Update existing builder tests + add tokenize test** — in `tests/spawn.test.ts`, change any assertion expecting a leading `"--"` from the builders, and add:

```ts
import { buildLaunchArgv, buildAnswerArgv, tokenizeCommand } from "../src/spawn.ts";

test("buildLaunchArgv has no leading -- (separator now lives in runner command)", () => {
  const a = buildLaunchArgv("uuid-1", "deep-research", "hello");
  expect(a[0]).toBe("--session-id");
  expect(a).not.toContain("--");
  expect(a).toEqual(["--session-id", "uuid-1", "-p", "/deep-research hello", "--permission-mode", "bypassPermissions"]);
});

test("buildAnswerArgv has no leading --", () => {
  const a = buildAnswerArgv("uuid-1", "echo: hi");
  expect(a[0]).toBe("--resume");
  expect(a).not.toContain("--");
});

test("tokenizeCommand splits prefix into argv head", () => {
  expect(tokenizeCommand("vc --")).toEqual(["vc", "--"]);
  expect(tokenizeCommand("claude_artem")).toEqual(["claude_artem"]);
  expect(tokenizeCommand("  vc   -- ")).toEqual(["vc", "--"]);
});
```

- [ ] **Step 2: Run to verify fail** — `bun test tests/spawn.test.ts` → FAIL (`tokenizeCommand` missing; old `--` assertions now wrong).

- [ ] **Step 3: Implement** — in `src/spawn.ts`:
  - `buildLaunchArgv` return → `return ["--session-id", uuid, "-p", prompt, ...PERM];`
  - `buildAnswerArgv` return → `return ["--resume", uuid, "-p", prompt, ...PERM];`
  - add:

```ts
/** Split a runner command prefix into argv tokens (whitespace-separated). */
export function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}
```

  - change `spawnTurn` signature and spawn line:

```ts
export function spawnTurn(vault: string, uuid: string, argv: string[], command: string): void {
  // ...unchanged setup...
  const proc = Bun.spawn([...tokenizeCommand(command), ...argv], {
    cwd: vault,
    env: { ...process.env, VOID_OS_SESSION: uuid },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  // ...unchanged watchdog/exit handling...
}
```

  Update any `spawnTurn(...)` call inside `spawn.test.ts` to pass a 4th arg (e.g. `"vc --"`).

- [ ] **Step 4: Run to verify pass** — `bun test tests/spawn.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spawn.ts tests/spawn.test.ts
git commit -m "feat(VOS-182): move -- separator into runner command; tokenizeCommand + spawnTurn command param"
```

---

## Task 3: server wiring — persist runner on launch, reuse on resume

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing tests** — add to `tests/server.test.ts` (mirror existing setup that builds the app + a temp vault):

```ts
// after POST /launch with runner=artem, session-meta.json records the resolved command
test("POST /launch persists resolved runner command in session-meta", async () => {
  const { vault, app } = makeTestApp(); // existing helper; if absent, build app via makeApp(vault)
  // seed a 2-runner config
  writeFileSync(join(vault, "void-os.json"), JSON.stringify({
    vault, onboarded: true, skills: ["smoke-test"], answers: {}, port: 4317,
    runners: [{ label: "vc (relay)", command: "vc --" }, { label: "artem", command: "claude_artem" }],
    defaultRunner: "vc (relay)",
  }));
  const res = await app.request("/launch", { method: "POST",
    body: new URLSearchParams({ skill: "smoke-test", text: "", runner: "artem" }) });
  expect(res.status).toBe(302);
  const uuid = res.headers.get("location")!.split("/s/")[1];
  const meta = JSON.parse(readFileSync(join(vault, "sessions", uuid, "session-meta.json"), "utf8"));
  expect(meta.runner).toBe("claude_artem");
});
```

> Note: `/launch` will actually fire `spawnTurn` (real `vc` spawn). The existing server tests already tolerate this (the spawn is fire-and-forget and writes to a log); assert only on the synchronously-written `session-meta.json`. If the relay-auth guard (`realDeps.vcStatus`) blocks launch in CI, stub it the same way existing `/launch` tests do.

- [ ] **Step 2: Run to verify fail** — `bun test tests/server.test.ts` → FAIL (`meta.runner` undefined).

- [ ] **Step 3: Implement** — in `src/server.ts`:
  - extend the paths import: `import { sessionDir, bodyPath, errorPath, configPath } from "./paths.ts";` → add `readConfig, resolveRunner`.
  - in `POST /launch`, after parsing `skill`/`text`:

```ts
const runnerLabel = String(body.runner ?? "");
const runnerCommand = resolveRunner(readConfig(vault), runnerLabel || undefined);
```

  - include `runner` in the session-meta write:

```ts
writeFileSync(
  join(dir, "session-meta.json"),
  JSON.stringify({ skill, launchedAt: Date.now(), text, runner: runnerCommand }),
);
```

  - pass it to spawn: `spawnTurn(vault, uuid, buildLaunchArgv(uuid, skill, text), runnerCommand);`
  - in `POST /s/:uuid/send`, before calling spawnTurn, recover the stored runner:

```ts
const metaPath = join(sessionDir(vault, uuid), "session-meta.json");
let runnerCommand = resolveRunner(readConfig(vault)); // default fallback for legacy sessions
if (existsSync(metaPath)) {
  try {
    const m = JSON.parse(readFileSync(metaPath, "utf8"));
    if (typeof m.runner === "string" && m.runner) runnerCommand = m.runner;
  } catch { /* keep default */ }
}
spawnTurn(vault, uuid, buildAnswerArgv(uuid, text), runnerCommand);
```

- [ ] **Step 4: Run to verify pass** — `bun test tests/server.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(VOS-182): persist runner on launch, reuse stored runner on resume"
```

---

## Task 4: dashboard UI — "Run as" select + per-form hidden runner input

**Files:**
- Modify: `src/render.ts`, `src/server.ts` (pass runner cfg to renderDashboard)
- Test: `tests/render.test.ts`

- [ ] **Step 1: Write failing tests** — add to `tests/render.test.ts`:

```ts
import { renderDashboard } from "../src/render.ts";

const TWO = { runners: [{ label: "vc (relay)", command: "vc --" }, { label: "artem", command: "claude_artem" }], defaultRunner: "vc (relay)" };
const ONE = { runners: [{ label: "vc (relay)", command: "vc --" }], defaultRunner: "vc (relay)" };

test("renders Run as select with default selected when >1 runner", () => {
  const html = renderDashboard([{ name: "smoke-test", description: "x", dir: "/d" } as any], [], { authed: true }, TWO);
  expect(html).toContain('id="runner-select"');
  expect(html).toContain('<option value="artem"');
  expect(html).toContain('value="vc (relay)" selected');
  expect(html).toContain('name="runner"'); // hidden input on chip forms
});

test("hides Run as select when only one runner", () => {
  const html = renderDashboard([{ name: "smoke-test", description: "x", dir: "/d" } as any], [], { authed: true }, ONE);
  expect(html).not.toContain('id="runner-select"');
});
```

- [ ] **Step 2: Run to verify fail** — `bun test tests/render.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/render.ts`:
  - import the type + defaults: `import { ..., type Runner, DEFAULT_RUNNERS, DEFAULT_RUNNER_LABEL } from "./paths.ts";` (or define a local `RunnerCfg` type to avoid a cycle — `render.ts` must not create an import cycle with `paths.ts`; if `paths.ts` imports nothing from `render.ts`, this is safe).
  - change signature (default keeps existing 3-arg callers/tests working):

```ts
export function renderDashboard(
  skills: CatalogSkill[],
  sessions: SessionInfo[],
  relay: { authed: boolean },
  runnerCfg: { runners: Runner[]; defaultRunner: string } = { runners: DEFAULT_RUNNERS, defaultRunner: DEFAULT_RUNNER_LABEL },
): string {
```

  - build the bar + options:

```ts
const showSelector = runnerCfg.runners.length > 1;
const runnerOptions = runnerCfg.runners
  .map((r) => `<option value="${esc(r.label)}"${r.label === runnerCfg.defaultRunner ? " selected" : ""}>${esc(r.label)}</option>`)
  .join("");
const runnerBar = showSelector
  ? `<div class="runner-bar"><label class="section-label">Run as</label>
     <select id="runner-select" onchange="syncRunner(this.value)">${runnerOptions}</select></div>`
  : "";
const runnerScript = showSelector
  ? `<script>function syncRunner(v){document.querySelectorAll('input[name=runner]').forEach(function(i){i.value=v})}</script>`
  : "";
```

  - add a hidden runner input to each chip form (inside the `.map`):

```ts
`<form action="/launch" method="POST" class="skill-chip-form">
  <input type="hidden" name="skill" value="${esc(s.name)}">
  <input type="hidden" name="runner" value="${esc(runnerCfg.defaultRunner)}">
  <button type="submit" class="skill-chip">
    <span>${esc(s.name)}</span>
    <input name="text" placeholder="optional input…" onclick="event.stopPropagation()">
  </button>
</form>`
```

  - render `${runnerBar}` immediately before `<div class="skill-chips">…`, and append `${runnerScript}` near the end of the page body.
  - in `src/server.ts` `GET /`, pass the config: `renderDashboard(listCatalogSkills(catalogRoot), listSessions(vault), { authed: status.ok }, readConfig(vault))`.

- [ ] **Step 4: Run to verify pass** — `bun test tests/render.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/server.ts tests/render.test.ts
git commit -m "feat(VOS-182): Run as dropdown on dashboard (hidden when single runner)"
```

---

## Task 5: init seeding lock-in test

**Files:**
- Test: `tests/init.test.ts` (no `src/init.ts` change — seeding happens via `readConfig`→`writeConfig` at `runInit`)

- [ ] **Step 1: Write failing/locking test** — add:

```ts
import { readConfig } from "../src/paths.ts";

test("seeded vault config carries runners + defaultRunner", async () => {
  const { runInit } = await import("../src/init.ts");
  const v = mkdtempSync(join(tmpdir(), "vos-init-"));
  await runInit([v]); // non-interactive: positional vault arg
  const cfg = readConfig(v);
  expect(cfg.runners[0].command).toBe("vc --");
  expect(cfg.defaultRunner).toBe("vc (relay)");
  // and it is persisted to disk, not just defaulted in-memory
  const onDisk = JSON.parse(readFileSync(join(v, "void-os.json"), "utf8"));
  expect(onDisk.runners).toBeDefined();
});
```

- [ ] **Step 2: Run** — `bun test tests/init.test.ts`. If it FAILS because `runInit` doesn't persist `runners`, fix `src/init.ts` to ensure the `cfg` written at `runInit` includes runner fields (it will, since `readConfig` now returns them and `writeConfig` serializes the whole object). If it already passes, the seeding is confirmed — keep the test as a regression lock.

- [ ] **Step 3: Commit**

```bash
git add tests/init.test.ts src/init.ts
git commit -m "test(VOS-182): lock runner seeding into new vault config"
```

---

## Task 6: `smoke-test` catalog skill

**Files:**
- Create: `catalog/skills/smoke-test/SKILL.md`
- Test: `tests/catalog.test.ts` (assert the skill is discoverable)

- [ ] **Step 1: Write the skill** — `catalog/skills/smoke-test/SKILL.md`:

```markdown
---
name: smoke-test
description: Cheap end-to-end smoke check — renders HTML and round-trips one form field. No research, no sub-agents.
---

# Smoke test

A minimal session that verifies the void-os render loop end-to-end at cold-start cost.
Do NOT use WebSearch, WebFetch, or sub-agents. Two turns only. The body file you write
is `sessions/$VOID_OS_SESSION/body.html` (relative to the vault, which is your cwd).

## What to do

**Turn 1 (launch):** Write `sessions/$VOID_OS_SESSION/body.html` containing:
- `<h1>smoke-test ✓ session live</h1>`,
- a `<p>` echoing any launch input text you were given (or "no input" if none),
- a single `<form action="/s/$VOID_OS_SESSION/send" method="POST">` with one text input
  named `echo` (placeholder "type anything") and a submit button.

Then stop. Do not reply in the terminal — `body.html` is the only output (render contract).

**Turn 2 (resume):** You will be resumed with a prompt containing `echo: <value>`.
Rewrite `sessions/$VOID_OS_SESSION/body.html` to:
- `<h1>round-trip ✓</h1>` and
- `<p>you sent: <value></p>`.

Then stop. Keep it to these two turns — this skill exists only to test the flow cheaply.
```

- [ ] **Step 2: Add discovery test** — in `tests/catalog.test.ts`, add/extend an assertion that `listCatalogSkills(catalogRoot)` includes a skill with `name === "smoke-test"`.

- [ ] **Step 3: Run** — `bun test tests/catalog.test.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add catalog/skills/smoke-test/SKILL.md tests/catalog.test.ts
git commit -m "feat(VOS-182): smoke-test skill — cheap full-loop render check"
```

---

## Task 7: Remove the `TEST:` hack + update memory

**Files:**
- Modify: `catalog/skills/deep-research/SKILL.md`
- Modify: `~/.claude/projects/-Users-admin-hub/memory/feedback_cheap_test_mode_for_expensive_skills.md`
- Modify: `~/.claude/projects/-Users-admin-hub/memory/MEMORY.md`

- [ ] **Step 1: Remove the block** — delete lines 13–24 of `catalog/skills/deep-research/SKILL.md` (the `### Test mode — short-circuit (check this FIRST)` section through "Real requests (no `TEST:` prefix) proceed below."). Verify deep-research no longer mentions `TEST:`:

```bash
grep -n "TEST" catalog/skills/deep-research/SKILL.md || echo "clean"
```

- [ ] **Step 2: Rewrite the memory** — replace the body of `feedback_cheap_test_mode_for_expensive_skills.md` to describe the new primitive: to test the void-os flow cheaply, launch the `smoke-test` skill (full launch→form→resume round-trip at cold-start cost), instead of the removed `TEST:` prefix. Update the matching one-line pointer in `MEMORY.md`.

- [ ] **Step 3: Commit** (deep-research only — memory files live outside the repo, commit separately to hub master per Hub Rules)

```bash
git add catalog/skills/deep-research/SKILL.md
git commit -m "refactor(VOS-182): drop TEST: hack from deep-research (replaced by smoke-test skill)"
```

---

## Task 8: Full typecheck + master e2e verification (Playwright)

**Files:**
- Create (test fixture): `tests/fixtures/fake-runner.sh`

This task is run by the **master personally** (per the VOS-181 standard — no subagent-claimed pass).

- [ ] **Step 1: Whole suite + typecheck**

```bash
cd workspace/void-os && bun test ; bunx tsc --noEmit ; echo "EXIT=$?"
```
Expected: all tests pass, tsc clean (EXIT=0).

- [ ] **Step 2: Fixture runner** — create `tests/fixtures/fake-runner.sh` (records argv, writes a body, exits 0) so the override path is verifiable without a second real token:

```sh
#!/bin/sh
# Fake runner: prove the chosen command + argv reach the spawn. Writes a body so the loop completes.
echo "FAKE-RUNNER ARGV: $*" >&2
# args are: --session-id <uuid> -p <prompt> --permission-mode bypassPermissions
uuid=""
while [ $# -gt 0 ]; do case "$1" in --session-id) uuid="$2"; shift 2;; *) shift;; esac; done
[ -n "$uuid" ] && printf '<h1>fake-runner ✓</h1>' > "sessions/$uuid/body.html"
exit 0
```
`chmod +x tests/fixtures/fake-runner.sh`.

- [ ] **Step 3: Init a fresh vault with two runners + serve**

```bash
bin/void-os init /tmp/vos-runner-e2e
# edit /tmp/vos-runner-e2e/void-os.json: add a second runner pointing at the fixture (absolute path)
#   "runners": [ {"label":"vc (relay)","command":"vc --"},
#                {"label":"fake","command":"<abs>/tests/fixtures/fake-runner.sh"} ]
VOID_OS_VAULT=/tmp/vos-runner-e2e bin/void-os serve   # note the port it prints
```

- [ ] **Step 4: Playwright — default (vc) smoke-test round-trip.** Navigate to the dashboard; launch `smoke-test` under the default runner; wait for SSE to swap the placeholder; confirm "smoke-test ✓ session live"; type into `echo`; submit; confirm "round-trip ✓ you sent: …". Screenshot each.

- [ ] **Step 5: Playwright — override path.** On the dashboard confirm the "Run as" select shows both runners with vc selected. Select `fake`, launch `smoke-test`, then assert the run log proves the override:

```bash
grep -r "FAKE-RUNNER ARGV: --session-id" /tmp/vos-runner-e2e/sessions/*/run-1.log
```
Expected: the line exists AND begins with `--session-id` (NO stray leading `--`), proving the fixture command was the argv head and the separator handling is correct. Screenshot the rendered `fake-runner ✓` body.

- [ ] **Step 6: Teardown** — kill the serve PID; confirm no orphan `vc`/fixture processes.

- [ ] **Step 7: Commit the fixture**

```bash
git add tests/fixtures/fake-runner.sh
git commit -m "test(VOS-182): fake-runner fixture for runner-override e2e"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** config+back-compat (T1), argv prefix/`--` move (T2), per-session persistence (T3), dropdown hidden-when-single (T4), init seeding (T5), smoke-test full loop (T6), TEST: removal + memory (T7), master Playwright incl. argv-head proof (T8). All spec sections mapped.
- **Type consistency:** `Runner{label,command}`, `resolveRunner(cfg,label?)`, `tokenizeCommand`, `spawnTurn(vault,uuid,argv,command)`, `renderDashboard(...,runnerCfg)` used identically across tasks.
- **No placeholders:** every code step shows real code; commands have expected output.
