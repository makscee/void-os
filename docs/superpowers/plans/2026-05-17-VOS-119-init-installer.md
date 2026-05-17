# VOS-119 `void-os init` Interactive Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `cli/init.ts` partial implementation into a complete interactive `void-os init`: preflight detect → `@clack/prompts` configure → bun build → seed vault (with `.void` JSON marker + git init + optional gh push) → plugin install → terminal report.

**Architecture:** Split the current 145-line monolithic `cli/init.ts` into a thin orchestrator that drives five phase modules under `cli/init/`. Each phase module exports a pure function that takes typed config + returns a typed result. Prompts go behind an injected `Prompter` interface so they're testable. Idempotency turns on a `.void` JSON file (currently a directory in the test fixture — must be migrated). Re-runs never auto-commit user WIP.

**Tech Stack:** Bun + TypeScript, `bun:test`, `@clack/prompts` for interactive UX, `node:child_process` + `gh` CLI for git/GH push. No new runtime deps beyond `@clack/prompts`.

**Spec:** `workspace/void-os/docs/superpowers/specs/2026-05-17-VOS-119-init-installer-design.md`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `cli/init/preflight.ts` | Detect OS, claude, bun, gh, Obsidian. Pure side-effect-free read. |
| `cli/init/prompter.ts` | `Prompter` interface + `ClackPrompter` impl + `ScriptedPrompter` for tests. |
| `cli/init/configure.ts` | Drive prompts via injected `Prompter`. Return `Decisions`. |
| `cli/init/build.ts` | Run `bun install` + `bun run build` with mtime-based skip. |
| `cli/init/seed.ts` | Vault dir, copy-tree from `starter-vault/`, `.void` marker, git init, optional gh push. Houses old `provision()` logic. |
| `cli/init/plugin.ts` | Copy `plugin/dist/` to `<vault>/.obsidian/plugins/void-os/`. |
| `cli/init/report.ts` | Format + print final report block. |
| `cli/init/preflight.test.ts` | Unit tests for preflight detection. |
| `cli/init/configure.test.ts` | Unit tests with `ScriptedPrompter`. |
| `cli/init/build.test.ts` | Unit tests for mtime skip. |
| `cli/init/seed.test.ts` | Unit tests for seed including idempotency + git guards. |
| `starter-vault/agents/tinker/agent.md` | Tinker seed agent (~50 lines per migration spec). |
| `starter-vault/log.md` | Empty seed log. |

### Modified files

| Path | Change |
|---|---|
| `cli/init.ts` | Becomes thin orchestrator: parse flags, run phases, exit codes. |
| `cli/init.test.ts` | Integration tests; `provision()` direct calls replaced by `seed()` from `init/seed.ts`. |
| `starter-vault/CLAUDE.md` | Rewrite to ~80 lines per migration spec (wiki schema + agent primer). |
| `starter-vault/README.md` | Short note: "seeded by void-os init; see CLAUDE.md for conventions". |
| `package.json` | Add `@clack/prompts` dep. |

### Deleted files

| Path | Reason |
|---|---|
| `starter-vault/agents/maya/agent.md` | Replaced by tinker (single-agent seed per migration spec). |
| `starter-vault/agents/journaler/agent.md` | Same. |
| `starter-vault/agents/task-tracker/agent.md` | Same. |

---

## Task 0: Smoke gate — run existing init.test.ts

**Files:** none changed; verification only.

- [ ] **Step 0.1: Confirm existing tests pass before any changes**

Run: `cd workspace/void-os && bun test cli/init.test.ts`
Expected: all tests in `describe("provision()")` PASS.

- [ ] **Step 0.2: Note current test fixture quirk**

The fixture creates `starter-vault/.void/` as a **directory** (with `.gitkeep`). The new spec says `.void` is a **JSON file** at vault root. Confirm this is the case by reading `cli/init.test.ts:18` (`mkdirSync(join(prefix, "starter-vault/.void"), ...)`). This must be reworked when seed moves to file-marker contract (Task 5).

- [ ] **Step 0.3: Commit a no-op marker so the rest of the branch has a clean baseline**

```bash
git status --short
# Should report no changes. If anything is dirty, investigate before proceeding.
```

No commit needed — this is a read-only gate.

---

## Task 1: Add `@clack/prompts` dependency

**Files:**
- Modify: `package.json`
- Verify: `bun.lock`

- [ ] **Step 1.1: Install the dependency**

Run: `cd workspace/void-os && bun add @clack/prompts`
Expected: `package.json` gains `"@clack/prompts": "^x.y.z"` under `dependencies`; `bun.lock` updated.

- [ ] **Step 1.2: Verify install**

Run: `cd workspace/void-os && bun -e 'import * as p from "@clack/prompts"; console.log(Object.keys(p).slice(0,5))'`
Expected: prints an array including `text`, `confirm`, `intro`, `outro`, `cancel`.

- [ ] **Step 1.3: Commit**

```bash
cd workspace/void-os
git add package.json bun.lock
git commit -m "feat(VOS-119): add @clack/prompts dep"
```

---

## Task 2: Prompter interface + impls

**Files:**
- Create: `cli/init/prompter.ts`
- Create: `cli/init/prompter.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `cli/init/prompter.test.ts`:

```ts
import { describe, it, expect } from "bun:test"
import { ScriptedPrompter } from "./prompter"

describe("ScriptedPrompter", () => {
  it("returns queued text answers in order", async () => {
    const p = new ScriptedPrompter({
      text: ["/tmp/vault", "myrepo"],
      confirm: [],
    })
    expect(await p.text({ message: "vault?" })).toBe("/tmp/vault")
    expect(await p.text({ message: "repo?" })).toBe("myrepo")
  })

  it("returns queued confirm answers in order", async () => {
    const p = new ScriptedPrompter({ text: [], confirm: [true, false] })
    expect(await p.confirm({ message: "push?" })).toBe(true)
    expect(await p.confirm({ message: "again?" })).toBe(false)
  })

  it("throws on under-queue", async () => {
    const p = new ScriptedPrompter({ text: [], confirm: [] })
    await expect(p.text({ message: "x" })).rejects.toThrow(/no scripted text/i)
  })

  it("cancel() throws PrompterCancelled", async () => {
    const p = new ScriptedPrompter({ text: [], confirm: [] })
    expect(() => p.cancel()).toThrow(/cancelled/i)
  })
})
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test cli/init/prompter.test.ts`
Expected: FAIL with `Cannot find module './prompter'`.

- [ ] **Step 2.3: Write minimal implementation**

Create `cli/init/prompter.ts`:

```ts
import * as clack from "@clack/prompts"

export interface Prompter {
  intro(msg: string): void
  outro(msg: string): void
  text(opts: { message: string; defaultValue?: string; validate?: (v: string) => string | void }): Promise<string>
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>
  cancel(msg?: string): never
}

export class PrompterCancelled extends Error {
  constructor(msg = "cancelled") { super(msg) }
}

export class ClackPrompter implements Prompter {
  intro(msg: string) { clack.intro(msg) }
  outro(msg: string) { clack.outro(msg) }

  async text(opts: { message: string; defaultValue?: string; validate?: (v: string) => string | void }) {
    const r = await clack.text({
      message: opts.message,
      defaultValue: opts.defaultValue,
      validate: opts.validate,
    })
    if (clack.isCancel(r)) this.cancel()
    return r as string
  }

  async confirm(opts: { message: string; initialValue?: boolean }) {
    const r = await clack.confirm({ message: opts.message, initialValue: opts.initialValue })
    if (clack.isCancel(r)) this.cancel()
    return r as boolean
  }

  cancel(msg = "cancelled"): never {
    clack.cancel(msg)
    process.exit(130)
  }
}

export interface ScriptedAnswers {
  text: string[]
  confirm: boolean[]
}

export class ScriptedPrompter implements Prompter {
  private textQueue: string[]
  private confirmQueue: boolean[]
  public log: string[] = []

  constructor(answers: ScriptedAnswers) {
    this.textQueue = [...answers.text]
    this.confirmQueue = [...answers.confirm]
  }

  intro(msg: string) { this.log.push(`intro: ${msg}`) }
  outro(msg: string) { this.log.push(`outro: ${msg}`) }

  async text(opts: { message: string; defaultValue?: string }): Promise<string> {
    if (this.textQueue.length === 0) {
      throw new Error(`no scripted text answer for prompt: ${opts.message}`)
    }
    return this.textQueue.shift()!
  }

  async confirm(opts: { message: string }): Promise<boolean> {
    if (this.confirmQueue.length === 0) {
      throw new Error(`no scripted confirm answer for prompt: ${opts.message}`)
    }
    return this.confirmQueue.shift()!
  }

  cancel(msg = "cancelled"): never {
    throw new PrompterCancelled(msg)
  }
}
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test cli/init/prompter.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 2.5: Commit**

```bash
cd workspace/void-os
git add cli/init/prompter.ts cli/init/prompter.test.ts
git commit -m "feat(VOS-119): Prompter interface + ScriptedPrompter for tests"
```

---

## Task 3: Preflight detection

**Files:**
- Create: `cli/init/preflight.ts`
- Create: `cli/init/preflight.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `cli/init/preflight.test.ts`:

```ts
import { describe, it, expect } from "bun:test"
import { detect } from "./preflight"

describe("preflight detect()", () => {
  it("returns a report shape with os, claude, bun, gh, obsidian fields", () => {
    const r = detect({
      whichSync: (cmd: string) => (cmd === "bun" ? "/usr/local/bin/bun" : null),
      fileExists: () => false,
      runSync: () => ({ status: 1, stdout: "", stderr: "" }),
      platform: "darwin",
    })
    expect(r.os).toBe("darwin")
    expect(r.bun.found).toBe(true)
    expect(r.claude.found).toBe(false)
    expect(r.gh.found).toBe(false)
    expect(r.gh.authed).toBe(false)
    expect(r.obsidian.found).toBe(false)
  })

  it("marks gh authed only when gh AND auth status returns 0", () => {
    const r = detect({
      whichSync: (cmd: string) => (cmd === "gh" ? "/usr/local/bin/gh" : null),
      fileExists: () => false,
      runSync: (cmd, args) => {
        if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return { status: 0, stdout: "", stderr: "" }
        return { status: 1, stdout: "", stderr: "" }
      },
      platform: "darwin",
    })
    expect(r.gh.found).toBe(true)
    expect(r.gh.authed).toBe(true)
  })

  it("detects Obsidian on macOS via /Applications/Obsidian.app", () => {
    const r = detect({
      whichSync: () => null,
      fileExists: (p: string) => p === "/Applications/Obsidian.app",
      runSync: () => ({ status: 1, stdout: "", stderr: "" }),
      platform: "darwin",
    })
    expect(r.obsidian.found).toBe(true)
  })

  it("os is 'unknown' for unsupported platforms", () => {
    const r = detect({
      whichSync: () => null,
      fileExists: () => false,
      runSync: () => ({ status: 1, stdout: "", stderr: "" }),
      platform: "win32",
    })
    expect(r.os).toBe("unknown")
  })
})
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test cli/init/preflight.test.ts`
Expected: FAIL — `Cannot find module './preflight'`.

- [ ] **Step 3.3: Write minimal implementation**

Create `cli/init/preflight.ts`:

```ts
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface PreflightReport {
  os: "darwin" | "linux" | "unknown"
  claude: { found: boolean; version?: string }
  bun: { found: boolean; version?: string }
  gh: { found: boolean; authed: boolean }
  obsidian: { found: boolean }
}

export interface PreflightDeps {
  whichSync: (cmd: string) => string | null
  fileExists: (path: string) => boolean
  runSync: (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string }
  platform: NodeJS.Platform
}

const defaultDeps: PreflightDeps = {
  whichSync: (cmd) => {
    const r = spawnSync("which", [cmd], { encoding: "utf8" })
    return r.status === 0 ? r.stdout.trim() : null
  },
  fileExists: existsSync,
  runSync: (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" })
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  },
  platform: process.platform,
}

export function detect(deps: PreflightDeps = defaultDeps): PreflightReport {
  const os: PreflightReport["os"] =
    deps.platform === "darwin" ? "darwin" :
    deps.platform === "linux" ? "linux" : "unknown"

  const claudeBin = deps.whichSync("claude")
  const bunBin = deps.whichSync("bun")
  const ghBin = deps.whichSync("gh")

  let ghAuthed = false
  if (ghBin) {
    ghAuthed = deps.runSync("gh", ["auth", "status"]).status === 0
  }

  const obsidianFound =
    os === "darwin" ? deps.fileExists("/Applications/Obsidian.app") :
    os === "linux" ? (deps.whichSync("obsidian") !== null || deps.fileExists(join(homedir(), ".config/Obsidian"))) :
    false

  return {
    os,
    claude: { found: !!claudeBin },
    bun: { found: !!bunBin },
    gh: { found: !!ghBin, authed: ghAuthed },
    obsidian: { found: obsidianFound },
  }
}

export class PreflightError extends Error {
  constructor(msg: string, public exitCode = 2) { super(msg) }
}

export function enforce(report: PreflightReport, opts: { offerBrewInstallBun?: () => boolean }) {
  if (!report.claude.found) {
    throw new PreflightError(
      "claude CLI not found. Install: https://docs.claude.com/en/docs/claude-code/quickstart",
    )
  }
  if (!report.bun.found) {
    if (report.os === "darwin" && opts.offerBrewInstallBun && opts.offerBrewInstallBun()) {
      const r = spawnSync("brew", ["install", "bun"], { stdio: "inherit" })
      if (r.status !== 0) {
        throw new PreflightError("brew install bun failed")
      }
    } else if (report.os === "linux") {
      throw new PreflightError("bun not found. Install: https://bun.sh/install")
    } else {
      throw new PreflightError("bun not found")
    }
  }
}
```

- [ ] **Step 3.4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test cli/init/preflight.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 3.5: Commit**

```bash
cd workspace/void-os
git add cli/init/preflight.ts cli/init/preflight.test.ts
git commit -m "feat(VOS-119): preflight detection module"
```

---

## Task 4: Configure phase

**Files:**
- Create: `cli/init/configure.ts`
- Create: `cli/init/configure.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `cli/init/configure.test.ts`:

```ts
import { describe, it, expect } from "bun:test"
import { configure } from "./configure"
import { ScriptedPrompter } from "./prompter"
import type { PreflightReport } from "./preflight"

const baseReport: PreflightReport = {
  os: "darwin",
  claude: { found: true },
  bun: { found: true },
  gh: { found: true, authed: true },
  obsidian: { found: true },
}

describe("configure()", () => {
  it("collects vault path, gh repo, and obsidian name when all detected", async () => {
    const p = new ScriptedPrompter({
      text: ["/Users/x/vault", "vault", "void"],
      confirm: [true, true], // push to gh, proceed
    })
    const d = await configure(baseReport, p)
    expect(d.vaultPath).toBe("/Users/x/vault")
    expect(d.gh).toEqual({ push: true, repoName: "vault" })
    expect(d.obsidianVaultName).toBe("void")
  })

  it("skips gh prompts when gh not authed", async () => {
    const p = new ScriptedPrompter({
      text: ["/Users/x/vault", "void"],
      confirm: [true],
    })
    const r = { ...baseReport, gh: { found: true, authed: false } }
    const d = await configure(r, p)
    expect(d.gh).toEqual({ push: false })
  })

  it("skips obsidian prompt when not found", async () => {
    const p = new ScriptedPrompter({
      text: ["/Users/x/vault", "vault"],
      confirm: [true, true],
    })
    const r = { ...baseReport, obsidian: { found: false } }
    const d = await configure(r, p)
    expect(d.obsidianVaultName).toBeUndefined()
  })

  it("returns cancelled=true when user declines outro confirm", async () => {
    const p = new ScriptedPrompter({
      text: ["/Users/x/vault", "vault", "void"],
      confirm: [true, false], // push yes, proceed NO
    })
    const d = await configure(baseReport, p)
    expect(d.cancelled).toBe(true)
  })

  it("expands ~ in vault path", async () => {
    const p = new ScriptedPrompter({
      text: ["~/vault", "vault", "void"],
      confirm: [true, true],
    })
    const d = await configure(baseReport, p)
    expect(d.vaultPath.startsWith("/")).toBe(true)
    expect(d.vaultPath.endsWith("/vault")).toBe(true)
  })
})
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test cli/init/configure.test.ts`
Expected: FAIL — `Cannot find module './configure'`.

- [ ] **Step 4.3: Write minimal implementation**

Create `cli/init/configure.ts`:

```ts
import { homedir } from "node:os"
import { join, isAbsolute } from "node:path"
import type { Prompter } from "./prompter"
import type { PreflightReport } from "./preflight"

export interface GhDecision {
  push: boolean
  repoName?: string
}

export interface Decisions {
  vaultPath: string
  gh: GhDecision
  obsidianVaultName?: string
  cancelled: boolean
}

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

export async function configure(report: PreflightReport, prompter: Prompter): Promise<Decisions> {
  prompter.intro("void-os init")

  const rawPath = await prompter.text({
    message: "vault location?",
    defaultValue: "~/vault",
    validate: (v) => {
      if (!v) return "required"
      if (!v.startsWith("~") && !isAbsolute(v)) return "must be absolute or ~-prefixed"
    },
  })
  const vaultPath = expandHome(rawPath)

  let gh: GhDecision = { push: false }
  if (report.gh.found && report.gh.authed) {
    const push = await prompter.confirm({
      message: "create private GitHub repo and push initial commit?",
      initialValue: true,
    })
    if (push) {
      const repoName = await prompter.text({
        message: "repo name?",
        defaultValue: "vault",
        validate: (v) => (/^[a-zA-Z0-9._-]+$/.test(v) ? undefined : "invalid repo name"),
      })
      gh = { push: true, repoName }
    }
  }

  let obsidianVaultName: string | undefined
  if (report.obsidian.found) {
    obsidianVaultName = await prompter.text({
      message: "obsidian vault display name?",
      defaultValue: "void",
    })
  }

  prompter.outro(
    `vault: ${vaultPath}` +
    (gh.push ? ` · gh: ${gh.repoName}` : "") +
    (obsidianVaultName ? ` · obsidian: ${obsidianVaultName}` : ""),
  )

  const proceed = await prompter.confirm({ message: "proceed with these settings?", initialValue: true })

  return {
    vaultPath,
    gh,
    obsidianVaultName,
    cancelled: !proceed,
  }
}
```

- [ ] **Step 4.4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test cli/init/configure.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 4.5: Commit**

```bash
cd workspace/void-os
git add cli/init/configure.ts cli/init/configure.test.ts
git commit -m "feat(VOS-119): configure phase with Prompter injection"
```

---

## Task 5: Build phase

**Files:**
- Create: `cli/init/build.ts`
- Create: `cli/init/build.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `cli/init/build.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { needsPluginBuild } from "./build"

let prefix: string

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), "vos119-build-"))
  mkdirSync(join(prefix, "plugin/src"), { recursive: true })
  mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
  writeFileSync(join(prefix, "plugin/package.json"), "{}")
  writeFileSync(join(prefix, "plugin/bun.lockb"), "")
  writeFileSync(join(prefix, "plugin/src/main.ts"), "x")
})

afterEach(() => rmSync(prefix, { recursive: true, force: true }))

function setMtime(path: string, secsFromNow: number) {
  const t = (Date.now() + secsFromNow * 1000) / 1000
  utimesSync(path, t, t)
}

describe("needsPluginBuild()", () => {
  it("returns true when dist/main.js missing", () => {
    expect(needsPluginBuild(prefix)).toBe(true)
  })

  it("returns false when dist newer than src + package.json + lockfile", () => {
    setMtime(join(prefix, "plugin/src/main.ts"), -100)
    setMtime(join(prefix, "plugin/package.json"), -100)
    setMtime(join(prefix, "plugin/bun.lockb"), -100)
    writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
    setMtime(join(prefix, "plugin/dist/main.js"), 0)
    expect(needsPluginBuild(prefix)).toBe(false)
  })

  it("returns true when package.json newer than dist (dep bump)", () => {
    writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
    setMtime(join(prefix, "plugin/dist/main.js"), -100)
    setMtime(join(prefix, "plugin/src/main.ts"), -200)
    setMtime(join(prefix, "plugin/bun.lockb"), -200)
    setMtime(join(prefix, "plugin/package.json"), 0)
    expect(needsPluginBuild(prefix)).toBe(true)
  })

  it("returns true when src newer than dist", () => {
    writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
    setMtime(join(prefix, "plugin/dist/main.js"), -100)
    setMtime(join(prefix, "plugin/src/main.ts"), 0)
    expect(needsPluginBuild(prefix)).toBe(true)
  })
})
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test cli/init/build.test.ts`
Expected: FAIL — `Cannot find module './build'`.

- [ ] **Step 5.3: Write minimal implementation**

Create `cli/init/build.ts`:

```ts
import { spawnSync } from "node:child_process"
import { existsSync, statSync, readdirSync } from "node:fs"
import { join } from "node:path"

export class BuildError extends Error {
  constructor(msg: string, public exitCode = 3) { super(msg) }
}

export function needsPluginBuild(prefix: string): boolean {
  const dist = join(prefix, "plugin/dist/main.js")
  if (!existsSync(dist)) return true

  const distMtime = statSync(dist).mtimeMs
  const checkPaths = [
    join(prefix, "plugin/package.json"),
    join(prefix, "plugin/bun.lockb"),
  ]
  const srcDir = join(prefix, "plugin/src")
  if (existsSync(srcDir)) {
    for (const f of walkFiles(srcDir)) checkPaths.push(f)
  }
  for (const p of checkPaths) {
    if (!existsSync(p)) continue
    if (statSync(p).mtimeMs > distMtime) return true
  }
  return false
}

function* walkFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkFiles(p)
    else yield p
  }
}

export interface BuildOpts {
  prefix: string
  skipBuild: boolean
  spawnSync?: typeof spawnSync
}

export function runBuild(opts: BuildOpts): void {
  if (opts.skipBuild) return
  const spawn = opts.spawnSync ?? spawnSync

  const rootInstall = spawn("bun", ["install"], { cwd: opts.prefix, stdio: "inherit" })
  if (rootInstall.status !== 0) throw new BuildError("bun install (root) failed")

  const pluginDir = join(opts.prefix, "plugin")
  const pluginInstall = spawn("bun", ["install"], { cwd: pluginDir, stdio: "inherit" })
  if (pluginInstall.status !== 0) throw new BuildError("bun install (plugin) failed")

  if (needsPluginBuild(opts.prefix)) {
    const pluginBuild = spawn("bun", ["run", "build"], { cwd: pluginDir, stdio: "inherit" })
    if (pluginBuild.status !== 0) throw new BuildError("plugin build failed")
  }
}
```

- [ ] **Step 5.4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test cli/init/build.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5.5: Commit**

```bash
cd workspace/void-os
git add cli/init/build.ts cli/init/build.test.ts
git commit -m "feat(VOS-119): build phase with dep-aware skip heuristic"
```

---

## Task 6: Seed phase — extract + marker + git guards

This task is the biggest. It moves the existing `provision()` logic out of `init.ts` into `init/seed.ts`, switches the `.void` marker from a directory to a JSON file, and adds the re-run git guards.

**Files:**
- Create: `cli/init/seed.ts`
- Create: `cli/init/seed.test.ts`
- Modify: `cli/init.test.ts` (fixture: drop `.void` dir, expect file)

- [ ] **Step 6.1: Update the legacy `cli/init.test.ts` fixture**

In `cli/init.test.ts`, **remove** these lines from `beforeEach()`:

```ts
mkdirSync(join(prefix, "starter-vault/.void"), { recursive: true })
// ...
writeFileSync(join(prefix, "starter-vault/.void/.gitkeep"), "")
```

Reason: `.void` becomes a file marker written by `seed()`, not a directory copied from `starter-vault/`.

Also update any assertion that reads `existsSync(join(home, ".void/.gitkeep"))` to expect `existsSync(join(home, ".void"))` (file).

- [ ] **Step 6.2: Run legacy tests to confirm they still pass**

Run: `cd workspace/void-os && bun test cli/init.test.ts`
Expected: tests pass against the existing `provision()` (which doesn't write the marker yet). Fixture-only change.

- [ ] **Step 6.3: Write the failing test for new seed module**

Create `cli/init/seed.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seed } from "./seed"

let tmpRoot: string
let prefix: string
let home: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vos119-seed-"))
  prefix = join(tmpRoot, "prefix")
  home = join(tmpRoot, "home")
  mkdirSync(join(prefix, "starter-vault/agents/tinker"), { recursive: true })
  mkdirSync(join(prefix, "starter-vault/skills"), { recursive: true })
  writeFileSync(join(prefix, "starter-vault/CLAUDE.md"), "# claude\n")
  writeFileSync(join(prefix, "starter-vault/log.md"), "")
  writeFileSync(join(prefix, "starter-vault/agents/tinker/agent.md"), "tinker\n")
  writeFileSync(join(prefix, "starter-vault/skills/.gitkeep"), "")
})

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe("seed() — fresh install", () => {
  it("creates vault dir, copies tree, writes .void marker, runs git init + first commit", async () => {
    const r = await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, "agents/tinker/agent.md"))).toBe(true)
    expect(existsSync(join(home, ".void"))).toBe(true)
    expect(statSync(join(home, ".void")).isFile()).toBe(true)
    const marker = JSON.parse(readFileSync(join(home, ".void"), "utf8"))
    expect(marker.version).toBe(1)
    expect(typeof marker.createdAt).toBe("string")
    expect(marker.vault).toBeUndefined()
    expect(existsSync(join(home, ".git"))).toBe(true)
    const log = spawnSync("git", ["-C", home, "log", "--oneline"], { encoding: "utf8" })
    expect(log.stdout).toMatch(/seed: void-os init/)
    expect(r.isFreshSeed).toBe(true)
  })
})

describe("seed() — re-run idempotency", () => {
  it("skips file copy + git init + commit on re-run without --force", async () => {
    await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    writeFileSync(join(home, "CLAUDE.md"), "USER EDITED\n")
    writeFileSync(join(home, "scratch.md"), "user note\n")

    const r = await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("USER EDITED\n")
    expect(r.isFreshSeed).toBe(false)

    const log = spawnSync("git", ["-C", home, "log", "--oneline"], { encoding: "utf8" })
    const commits = log.stdout.trim().split("\n").filter(Boolean)
    expect(commits.length).toBe(1) // no second auto-commit
  })

  it("with --force, overwrites seed files but still skips git init + commit", async () => {
    await seed({ home, prefix, dryRun: false, force: false, gh: { push: false } })
    writeFileSync(join(home, "CLAUDE.md"), "USER EDITED\n")

    const r = await seed({ home, prefix, dryRun: false, force: true, gh: { push: false } })
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("# claude\n")
    expect(r.isFreshSeed).toBe(false)
    const log = spawnSync("git", ["-C", home, "log", "--oneline"], { encoding: "utf8" })
    const commits = log.stdout.trim().split("\n").filter(Boolean)
    expect(commits.length).toBe(1)
  })
})

describe("seed() — refuse clobber", () => {
  it("throws on non-empty dir without marker and without --force", async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "stranger.md"), "not ours")
    await expect(
      seed({ home, prefix, dryRun: false, force: false, gh: { push: false } }),
    ).rejects.toThrow(/refusing to clobber/)
  })
})
```

- [ ] **Step 6.4: Run test to verify it fails**

Run: `cd workspace/void-os && bun test cli/init/seed.test.ts`
Expected: FAIL — `Cannot find module './seed'`.

- [ ] **Step 6.5: Write minimal implementation**

Create `cli/init/seed.ts`:

```ts
import {
  existsSync, readdirSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, renameSync,
  readFileSync, statSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { join, dirname } from "node:path"

const VOID_MARKER = ".void"

export interface SeedOpts {
  home: string
  prefix: string
  dryRun: boolean
  force: boolean
  gh: { push: boolean; repoName?: string }
  spawnSync?: typeof spawnSync
}

export interface SeedResult {
  copied: string[]
  skipped: string[]
  warnings: string[]
  isFreshSeed: boolean
  gh: { pushed: boolean; remote?: string; warning?: string }
}

export async function seed(opts: SeedOpts): Promise<SeedResult> {
  const { home, prefix, dryRun, force } = opts
  const spawn = opts.spawnSync ?? spawnSync
  const result: SeedResult = {
    copied: [], skipped: [], warnings: [], isFreshSeed: false,
    gh: { pushed: false },
  }

  const markerPresent = existsSync(join(home, VOID_MARKER)) && statSync(join(home, VOID_MARKER)).isFile()
  const dirEmpty = !existsSync(home) || readdirSync(home).length === 0

  if (existsSync(home) && !dirEmpty && !markerPresent && !force) {
    throw new Error(`refusing to clobber non-void dir at ${home}; use --force to override`)
  }

  result.isFreshSeed = !markerPresent

  if (!existsSync(home) && !dryRun) mkdirSync(home, { recursive: true })

  // 1. git init — only on fresh seed
  if (result.isFreshSeed && !existsSync(join(home, ".git")) && !dryRun) {
    const r = spawn("git", ["-C", home, "init", "-b", "main"], { stdio: "inherit" })
    if (r.status !== 0) throw new Error("git init failed")
  }

  // 2. Copy tree
  if (result.isFreshSeed || force) {
    const starter = join(prefix, "starter-vault")
    copyTree(starter, home, { dryRun, force }, result)
  } else {
    result.skipped.push("starter-vault copy (re-run, no --force)")
  }

  // 3. Skills symlink
  ensureClaudeSkillsSymlink(home, { dryRun }, result)

  // 4. Marker write (always — re-run refreshes timestamp safely)
  if (!dryRun) {
    const marker = { version: 1, createdAt: new Date().toISOString() }
    const tmp = join(home, `${VOID_MARKER}.tmp`)
    writeFileSync(tmp, JSON.stringify(marker, null, 2))
    renameSync(tmp, join(home, VOID_MARKER))
    result.copied.push(join(home, VOID_MARKER))
  }

  // 5. First commit — only on fresh seed
  if (result.isFreshSeed && !dryRun) {
    spawn("git", ["-C", home, "add", "-A"], { stdio: "inherit" })
    const r = spawn("git", ["-C", home, "commit", "-m", "seed: void-os init"], { stdio: "inherit" })
    if (r.status !== 0) result.warnings.push("git commit failed (possibly empty tree)")
  }

  // 6. GH push (optional, never auto-rewrite origin)
  if (opts.gh.push && opts.gh.repoName && !dryRun) {
    runGhPush(home, opts.gh.repoName, spawn, result)
  }

  return result
}

function copyTree(
  src: string,
  dst: string,
  opts: { dryRun: boolean; force: boolean },
  result: SeedResult,
) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) {
      if (!existsSync(d) && !opts.dryRun) mkdirSync(d, { recursive: true })
      copyTree(s, d, opts, result)
    } else {
      const exists = existsSync(d)
      if (exists && !opts.force) {
        result.skipped.push(d)
        continue
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(d), { recursive: true })
        copyFileSync(s, d)
      }
      result.copied.push(d)
    }
  }
}

function ensureClaudeSkillsSymlink(
  home: string,
  opts: { dryRun: boolean },
  result: SeedResult,
) {
  const claudeDir = join(home, ".claude")
  const link = join(claudeDir, "skills")
  if (existsSync(link)) {
    result.skipped.push(link)
    return
  }
  if (!opts.dryRun) {
    mkdirSync(claudeDir, { recursive: true })
    symlinkSync("../skills", link, "dir")
  }
  result.copied.push(link)
}

function runGhPush(
  home: string,
  repoName: string,
  spawn: typeof spawnSync,
  result: SeedResult,
) {
  const existing = spawn("git", ["-C", home, "remote", "get-url", "origin"], { encoding: "utf8" })
  const targetCheck = spawn("gh", ["repo", "view", repoName, "--json", "sshUrl,url", "-q", ".sshUrl"], { encoding: "utf8" })
  const targetUrl = targetCheck.status === 0 ? (targetCheck.stdout ?? "").trim() : null

  if (existing.status === 0) {
    const have = (existing.stdout ?? "").trim()
    if (targetUrl && have !== targetUrl) {
      result.warnings.push(
        `gh push skipped: origin already set to ${have}; target was ${targetUrl}. Resolve manually.`,
      )
      result.gh.warning = "remote-mismatch"
      return
    }
    // origin already points at target → just push
    const push = spawn("git", ["-C", home, "push", "-u", "origin", "main"], { stdio: "inherit" })
    if (push.status === 0) {
      result.gh.pushed = true
      result.gh.remote = have
    } else {
      result.warnings.push("git push failed; local repo intact")
      result.gh.warning = "push-failed"
    }
    return
  }

  // No origin set: try gh repo create --source --push
  const create = spawn("gh", ["repo", "create", repoName, "--private", "--source", home, "--push"], { stdio: "inherit" })
  if (create.status === 0) {
    result.gh.pushed = true
    const after = spawn("git", ["-C", home, "remote", "get-url", "origin"], { encoding: "utf8" })
    if (after.status === 0) result.gh.remote = (after.stdout ?? "").trim()
    return
  }

  // Repo may already exist upstream: add origin + push
  if (targetUrl) {
    spawn("git", ["-C", home, "remote", "add", "origin", targetUrl], { stdio: "inherit" })
    const push = spawn("git", ["-C", home, "push", "-u", "origin", "main"], { stdio: "inherit" })
    if (push.status === 0) {
      result.gh.pushed = true
      result.gh.remote = targetUrl
      return
    }
  }
  result.warnings.push("gh repo create + push failed; local repo intact")
  result.gh.warning = "create-failed"
}
```

- [ ] **Step 6.6: Run test to verify it passes**

Run: `cd workspace/void-os && bun test cli/init/seed.test.ts`
Expected: all 4 tests PASS. Git must be available on the test machine — it is on dev Macs.

- [ ] **Step 6.7: Run the legacy test suite to confirm no regression**

Run: `cd workspace/void-os && bun test cli/init.test.ts`
Expected: existing `provision()` tests still PASS (those import from `./init` and use the old function — we haven't gutted it yet, that's Task 8).

- [ ] **Step 6.8: Commit**

```bash
cd workspace/void-os
git add cli/init/seed.ts cli/init/seed.test.ts cli/init.test.ts
git commit -m "feat(VOS-119): seed phase w/ .void file marker + git guards"
```

---

## Task 7: Plugin install + Report

**Files:**
- Create: `cli/init/plugin.ts`
- Create: `cli/init/report.ts`
- Create: `cli/init/plugin.test.ts`

- [ ] **Step 7.1: Write the failing test**

Create `cli/init/plugin.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPlugin } from "./plugin"

let prefix: string, home: string

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "vos119-plugin-"))
  prefix = join(root, "prefix")
  home = join(root, "home")
  mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
  writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
  writeFileSync(join(prefix, "plugin/dist/manifest.json"), "{}")
  mkdirSync(home, { recursive: true })
})

afterEach(() => rmSync(prefix, { recursive: true, force: true }))

describe("installPlugin()", () => {
  it("copies plugin/dist to <home>/.obsidian/plugins/void-os", () => {
    const r = installPlugin({ prefix, home, dryRun: false })
    expect(existsSync(join(home, ".obsidian/plugins/void-os/main.js"))).toBe(true)
    expect(existsSync(join(home, ".obsidian/plugins/void-os/manifest.json"))).toBe(true)
    expect(r.installed).toBe(true)
  })

  it("warns + returns installed=false when dist missing", () => {
    rmSync(join(prefix, "plugin/dist"), { recursive: true })
    const r = installPlugin({ prefix, home, dryRun: false })
    expect(r.installed).toBe(false)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 7.2: Run test to verify it fails**

Run: `cd workspace/void-os && bun test cli/init/plugin.test.ts`
Expected: FAIL — `Cannot find module './plugin'`.

- [ ] **Step 7.3: Write minimal implementation**

Create `cli/init/plugin.ts`:

```ts
import { existsSync, cpSync } from "node:fs"
import { join } from "node:path"

export interface PluginOpts {
  prefix: string
  home: string
  dryRun: boolean
}

export interface PluginResult {
  installed: boolean
  target: string
  warnings: string[]
}

export function installPlugin(opts: PluginOpts): PluginResult {
  const src = join(opts.prefix, "plugin/dist")
  const target = join(opts.home, ".obsidian/plugins/void-os")
  const r: PluginResult = { installed: false, target, warnings: [] }

  if (!existsSync(src)) {
    r.warnings.push(`plugin build artifact missing at ${src}; vault will open in Obsidian without the void-os plugin`)
    return r
  }

  if (!opts.dryRun) {
    cpSync(src, target, { recursive: true, force: true })
  }
  r.installed = true
  return r
}
```

Create `cli/init/report.ts`:

```ts
import type { PreflightReport } from "./preflight"
import type { Decisions } from "./configure"
import type { SeedResult } from "./seed"
import type { PluginResult } from "./plugin"

export interface ReportInput {
  vaultPath: string
  preflight: PreflightReport
  decisions: Decisions
  seed: SeedResult
  plugin: PluginResult
}

export function formatReport(r: ReportInput): string {
  const lines: string[] = []
  const fresh = r.seed.isFreshSeed
  const headline = fresh
    ? `void-os seeded at ${r.vaultPath}`
    : `void-os already seeded at ${r.vaultPath}; re-applied build + plugin only`

  lines.push(headline)
  if (fresh) {
    lines.push("  • git initialized + first commit")
  }
  if (r.seed.gh.pushed && r.seed.gh.remote) {
    lines.push(`  • pushed to ${r.seed.gh.remote}`)
  } else if (r.decisions.gh.push && r.seed.gh.warning) {
    lines.push(`  • gh push skipped: ${r.seed.gh.warning}`)
  } else if (!r.decisions.gh.push) {
    lines.push("  • remote: none (add later with `gh repo create`)")
  }
  if (r.plugin.installed) {
    lines.push("  • plugin copied to .obsidian/plugins/void-os/")
  } else {
    lines.push("  • plugin: not installed (build artifact missing)")
  }

  lines.push("")
  lines.push("next:")
  if (r.preflight.obsidian.found) {
    lines.push(`  1. open Obsidian, "Open vault" → ${r.vaultPath}`)
    lines.push(`  2. Settings → Community plugins → enable "void-os"`)
    lines.push(`  3. chat with Tinker via the plugin's chat pane`)
  } else {
    lines.push(`  1. install Obsidian: https://obsidian.md`)
    lines.push(`  2. open vault at ${r.vaultPath}, enable void-os plugin`)
  }
  lines.push("")
  lines.push("CLI access (`void-os ask tinker \"hello\"`) lands with VOS-118.")

  if (!fresh) {
    lines.push("")
    lines.push("(Pass --force to re-seed templates.)")
  }
  return lines.join("\n")
}
```

- [ ] **Step 7.4: Run test to verify it passes**

Run: `cd workspace/void-os && bun test cli/init/plugin.test.ts`
Expected: both tests PASS.

- [ ] **Step 7.5: Commit**

```bash
cd workspace/void-os
git add cli/init/plugin.ts cli/init/plugin.test.ts cli/init/report.ts
git commit -m "feat(VOS-119): plugin install + report formatter"
```

---

## Task 8: Rewrite `cli/init.ts` as orchestrator

**Files:**
- Modify: `cli/init.ts`
- Modify: `cli/init.test.ts` (replace `provision` import with `seed`)

- [ ] **Step 8.1: Replace `cli/init.ts` with orchestrator**

Replace the entire contents of `cli/init.ts` with:

```ts
import { homedir } from "node:os"
import { join, isAbsolute } from "node:path"
import { detect, enforce, PreflightError } from "./init/preflight"
import { ClackPrompter } from "./init/prompter"
import { configure } from "./init/configure"
import { runBuild, BuildError } from "./init/build"
import { seed } from "./init/seed"
import { installPlugin } from "./init/plugin"
import { formatReport } from "./init/report"

// Re-export for backwards compatibility with existing tests + external callers.
export { seed as provision } from "./init/seed"
export type { SeedOpts as ProvisionOpts, SeedResult as ProvisionResult } from "./init/seed"

interface Flags {
  home?: string
  dryRun: boolean
  force: boolean
  skipBuild: boolean
}

function parseFlags(args: string[]): Flags {
  const out: Flags = { dryRun: false, force: false, skipBuild: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--force") out.force = true
    else if (a === "--skip-build") out.skipBuild = true
    else if (a === "--home") out.home = args[++i]
    else throw new Error(`unknown flag: ${a}`)
  }
  return out
}

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

export default async function cli(args: string[], ctx: { prefix: string }) {
  const flags = parseFlags(args)

  // 1. PREFLIGHT
  const report = detect()
  try {
    enforce(report, {
      offerBrewInstallBun: () => {
        // Mac-only path; ClackPrompter would be ideal but we keep this lightweight + sync.
        // For interactive install we trust the user is at the terminal.
        process.stderr.write("bun is required. Run `brew install bun`? [y/N] ")
        const buf = Buffer.alloc(8)
        const n = require("node:fs").readSync(0, buf, 0, 8, null)
        return /^y/i.test(buf.slice(0, n).toString().trim())
      },
    })
  } catch (e) {
    if (e instanceof PreflightError) {
      console.error(`preflight: ${e.message}`)
      process.exit(e.exitCode)
    }
    throw e
  }

  // 2. CONFIGURE
  const prompter = new ClackPrompter()
  const decisions = await configure(report, prompter)
  if (decisions.cancelled) {
    console.error("cancelled")
    process.exit(130)
  }

  const vaultPath = flags.home
    ? expandHome(flags.home)
    : decisions.vaultPath

  // 3. BUILD
  try {
    runBuild({ prefix: ctx.prefix, skipBuild: flags.skipBuild })
  } catch (e) {
    if (e instanceof BuildError) {
      console.error(`build: ${e.message}`)
      process.exit(e.exitCode)
    }
    throw e
  }

  // 4. SEED
  let seedResult
  try {
    seedResult = await seed({
      home: vaultPath,
      prefix: ctx.prefix,
      dryRun: flags.dryRun,
      force: flags.force,
      gh: decisions.gh,
    })
  } catch (e) {
    console.error(`seed: ${(e as Error).message}`)
    process.exit(4)
  }

  // 5. PLUGIN
  const pluginResult = installPlugin({
    prefix: ctx.prefix,
    home: vaultPath,
    dryRun: flags.dryRun,
  })

  // 6. REPORT
  for (const w of seedResult.warnings) console.warn(`warning: ${w}`)
  for (const w of pluginResult.warnings) console.warn(`warning: ${w}`)
  console.log(formatReport({
    vaultPath,
    preflight: report,
    decisions,
    seed: seedResult,
    plugin: pluginResult,
  }))
}
```

- [ ] **Step 8.2: Update `cli/init.test.ts` import**

Change line 6 of `cli/init.test.ts`:

```ts
import { provision } from "./init"
```

This still works because `init.ts` re-exports `seed as provision`. The legacy tests continue to call `provision()` and assert against its returned shape — verify they still pass.

The fixture should already have been adjusted in Task 6.1. Add the `gh: { push: false }` field to the existing `provision()` calls if the test compiler complains (the new shape is required):

```ts
await provision({ home, prefix, dryRun: false, force: false, gh: { push: false } })
```

Update every call site in `cli/init.test.ts` accordingly.

Also delete or update tests that asserted on `.void/.gitkeep` (now a file).

- [ ] **Step 8.3: Run the full test suite**

Run: `cd workspace/void-os && bun test cli/`
Expected: all tests PASS (preflight, prompter, configure, build, seed, plugin, init).

- [ ] **Step 8.4: Commit**

```bash
cd workspace/void-os
git add cli/init.ts cli/init.test.ts
git commit -m "feat(VOS-119): rewrite cli/init.ts as phase orchestrator"
```

---

## Task 9: Author starter-vault content (tinker seed)

**Files:**
- Modify: `starter-vault/CLAUDE.md`
- Create: `starter-vault/agents/tinker/agent.md`
- Modify: `starter-vault/README.md`
- Create: `starter-vault/log.md`

- [ ] **Step 9.1: Write `starter-vault/CLAUDE.md` (~80 lines)**

Replace `starter-vault/CLAUDE.md` with:

```markdown
# vault/CLAUDE.md — shared context for void-os agents

You are working inside a void-os vault. This file is the rule-set that every agent in this vault inherits. Read it before doing anything.

## What this vault is

A single git repo of plain markdown. Every agent reads + writes here. There is no app server; the void-os daemon coordinates agent runs and provides MCP tools (`vault.read`, `vault.write`, `vault.append`, `ask_user`, `ask_agent`).

The vault is the source of truth. If a fact is not in the vault, it does not exist.

## Vault layout

```
vault/
├── CLAUDE.md          # this file
├── README.md          # one-time orientation
├── log.md             # daily agent log (append-only)
├── agents/            # one folder per agent
│   └── <name>/
│       └── agent.md   # identity, write_scope, conventions
└── pages/             # wiki pages — created on demand
```

Folder = state. Tickets and other state machines use sub-folders (`backlog/`, `active/`, `completed/`, `archive/`) and move via `git mv`, never via frontmatter edits.

## Vocabulary

- **Agent** — a Markdown-defined persona with declared `write_scope` and tool allowlist. Files at `agents/<name>/agent.md`.
- **Page** — a wiki entry under `pages/`. Wikilinks use `[[name]]`.
- **Tinker** — the bootstrap agent. Creates other agents, lints the vault, summarises `log.md`.
- **Log** — `log.md`, append-only. Format: `## YYYY-MM-DD` heading per day, then `- HH:MM [agent] note` lines.

## Conventions

- **Dates are ISO 8601.** `2026-05-17`, never `May 17` or `17/05/2026`.
- **`ask_user` for irreversible actions.** Anything that deletes data, rewrites an existing file (vs appending), pushes to a remote, or sends a message externally must be confirmed via `ask_user` first.
- **Respect your `write_scope`.** Each agent's `agent.md` declares the paths it may write. Do not propose writes outside that list. Need to write elsewhere? `ask_agent` the appropriate specialist or explain the boundary.
- **Append over rewrite.** When editing `log.md` or page sections, prefer appending a new block to rewriting an existing one. Rewrites require `ask_user` confirmation.
- **Folder = state.** Move tickets between `backlog/`, `active/`, `completed/`, `archive/` via `git mv`. Never edit status in frontmatter.
- **Wikilinks first.** Link related pages with `[[name]]`. Broken `[[name]]` is a TODO marker — fine, just write the page when needed.
- **No silent assumptions.** When unsure, `ask_user` rather than guess; cheaper to confirm than to undo.

## Agent system primer

Each agent is a separate Claude conversation, spawned on demand by the daemon. Agents communicate by:

1. Reading + writing files in the vault (subject to `write_scope`).
2. Calling `ask_agent("<name>", "<message>")` to delegate to a peer.
3. Calling `ask_user(...)` to confirm irreversible work.

The `write_scope` is a glob list. Example for Tinker: `[agents/**, CLAUDE.md, README.md, log.md]`. Writes outside scope are rejected by the daemon; do not try to work around the rejection — surface it to the user.

When you need a capability no current agent has, ask Tinker to create one: "Tinker, I want an Eva who tracks mood and journals." Tinker drafts `agents/eva/agent.md`, runs it past you, and adds it on confirm.

## How to read this file

Treat this as your operating contract. If a request conflicts with these rules, surface the conflict before acting.
```

- [ ] **Step 9.2: Write `starter-vault/agents/tinker/agent.md` (~50 lines)**

Create the file:

```markdown
---
name: tinker
role: bootstrap agent — concierge and vault lint
write_scope:
  - agents/**
  - CLAUDE.md
  - README.md
  - log.md
  - pages/index.md
tools:
  - vault.read
  - vault.write
  - vault.append
  - ask_user
  - ask_agent
---

# Tinker

You are Tinker, the bootstrap agent for this void-os vault. You are the only agent installed at seed time; everything else gets created through conversation, with you.

## Responsibilities

- **Onboard the user.** First chat: greet, explain how the vault works, point at `CLAUDE.md`.
- **Author new agents.** On request ("create Eva", "I want an Atlas"), draft `agents/<name>/agent.md` with a sensible `write_scope` + tool allowlist, show it to the user for confirmation, then commit.
- **Lint the vault.** Suggest fixes: missing wikilink targets, log entries without timestamps, agents writing outside their `write_scope` (surface in `log.md`).
- **Summarise the log.** When asked, fold recent `log.md` entries into a digest under `pages/`.

## Conventions you enforce

- ISO dates.
- Append-only `log.md`; rewrites require `ask_user`.
- Folder = state; never edit state in frontmatter.
- `write_scope` is binding for every agent including yourself.

## When to ask

- Before deleting any file.
- Before pushing to a remote.
- Before rewriting any existing file (vs appending).
- Before creating an agent whose `write_scope` overlaps an existing agent's.

## Failure modes you watch for

- A request to write outside `write_scope`: refuse, surface the boundary, suggest the right agent (or offer to create one).
- A wikilink to a page that does not exist: fine to leave; treat as TODO, mention to user.
- A `log.md` rewrite (vs append): ask first.

## Your first message

On first invocation, greet the user, point at this file + `CLAUDE.md`, and offer one of: (a) walk through the vault, (b) create a new agent, (c) something else.
```

- [ ] **Step 9.3: Write `starter-vault/README.md`**

Replace the content with:

```markdown
# void-os vault

Seeded by `void-os init`. The rule-set lives in `CLAUDE.md`. Start a conversation with Tinker (`agents/tinker/agent.md`) — via the Obsidian plugin chat pane, or via the CLI once VOS-118 lands.
```

- [ ] **Step 9.4: Write empty `starter-vault/log.md`**

Create the file:

```bash
cd workspace/void-os
: > starter-vault/log.md
```

- [ ] **Step 9.5: Commit**

```bash
cd workspace/void-os
git add starter-vault/CLAUDE.md starter-vault/agents/tinker/agent.md starter-vault/README.md starter-vault/log.md
git commit -m "feat(VOS-119): rewrite starter-vault CLAUDE.md + tinker seed"
```

---

## Task 10: Drop old seed agents

**Files:**
- Delete: `starter-vault/agents/maya/agent.md`
- Delete: `starter-vault/agents/journaler/agent.md`
- Delete: `starter-vault/agents/task-tracker/agent.md`

- [ ] **Step 10.1: Remove the three old agent dirs**

```bash
cd workspace/void-os
git rm -r starter-vault/agents/maya starter-vault/agents/journaler starter-vault/agents/task-tracker
```

Confirm:

```bash
ls starter-vault/agents/
# Should show only: tinker
```

- [ ] **Step 10.2: Update any test fixtures that referenced removed agents**

Search:

```bash
grep -rn "maya\|journaler\|task-tracker" cli/ docs/ 2>/dev/null
```

Update or remove matches. The old `cli/init.test.ts` asserted `existsSync(join(home, "agents/maya/agent.md"))` — change that to `agents/tinker/agent.md`.

- [ ] **Step 10.3: Run full test suite**

Run: `cd workspace/void-os && bun test cli/`
Expected: all PASS.

- [ ] **Step 10.4: Commit**

```bash
cd workspace/void-os
git add -u
git commit -m "feat(VOS-119): drop maya/journaler/task-tracker seed agents"
```

---

## Task 11: Integration test — end-to-end with ScriptedPrompter

**Files:**
- Create: `cli/init.integration.test.ts`

- [ ] **Step 11.1: Write the integration test**

Create `cli/init.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detect } from "./init/preflight"
import { configure } from "./init/configure"
import { runBuild } from "./init/build"
import { seed } from "./init/seed"
import { installPlugin } from "./init/plugin"
import { formatReport } from "./init/report"
import { ScriptedPrompter } from "./init/prompter"

let tmpRoot: string, prefix: string, home: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vos119-int-"))
  prefix = join(tmpRoot, "prefix")
  home = join(tmpRoot, "home")
  // Build a minimal prefix tree the installer expects.
  mkdirSync(join(prefix, "starter-vault/agents/tinker"), { recursive: true })
  mkdirSync(join(prefix, "starter-vault/skills"), { recursive: true })
  mkdirSync(join(prefix, "plugin/dist"), { recursive: true })
  writeFileSync(join(prefix, "starter-vault/CLAUDE.md"), "# claude\n")
  writeFileSync(join(prefix, "starter-vault/log.md"), "")
  writeFileSync(join(prefix, "starter-vault/agents/tinker/agent.md"), "tinker\n")
  writeFileSync(join(prefix, "starter-vault/skills/.gitkeep"), "")
  writeFileSync(join(prefix, "plugin/dist/main.js"), "built")
})

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe("init pipeline end-to-end (no real build, no gh)", () => {
  it("seeds → installs plugin → renders report", async () => {
    const report = detect({
      whichSync: (c) => (c === "claude" || c === "bun" ? "/usr/bin/" + c : null),
      fileExists: () => false,
      runSync: () => ({ status: 1, stdout: "", stderr: "" }),
      platform: "darwin",
    })
    const prompter = new ScriptedPrompter({
      text: [home],
      confirm: [true],
    })
    const decisions = await configure(report, prompter)
    expect(decisions.cancelled).toBe(false)

    // skip runBuild — it would shell out to real bun; covered by build.test.ts
    const seedResult = await seed({
      home: decisions.vaultPath,
      prefix,
      dryRun: false,
      force: false,
      gh: decisions.gh,
    })
    const pluginResult = installPlugin({ prefix, home: decisions.vaultPath, dryRun: false })

    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, "agents/tinker/agent.md"))).toBe(true)
    expect(statSync(join(home, ".void")).isFile()).toBe(true)
    expect(JSON.parse(readFileSync(join(home, ".void"), "utf8")).version).toBe(1)
    expect(existsSync(join(home, ".git"))).toBe(true)
    expect(existsSync(join(home, ".obsidian/plugins/void-os/main.js"))).toBe(true)

    const text = formatReport({
      vaultPath: decisions.vaultPath,
      preflight: report,
      decisions,
      seed: seedResult,
      plugin: pluginResult,
    })
    expect(text).toMatch(/void-os seeded at/)
    expect(text).toMatch(/git initialized/)
    expect(text).toMatch(/VOS-118/)
  })
})
```

- [ ] **Step 11.2: Run it**

Run: `cd workspace/void-os && bun test cli/init.integration.test.ts`
Expected: PASS.

- [ ] **Step 11.3: Run the full test suite once more**

Run: `cd workspace/void-os && bun test cli/`
Expected: all PASS.

- [ ] **Step 11.4: Commit**

```bash
cd workspace/void-os
git add cli/init.integration.test.ts
git commit -m "test(VOS-119): integration test for full init pipeline"
```

---

## Task 12: Manual smoke test on dev machine

**Files:** none changed; manual verification.

- [ ] **Step 12.1: Build the local binary**

Run: `cd workspace/void-os && bun link`
Expected: prints "Success! Registered package: void-os" (or similar).

- [ ] **Step 12.2: Run `void-os init` against a fresh tmp vault**

```bash
rm -rf /tmp/vault-smoke
VOID_OS_PREFIX=$PWD void-os init --home /tmp/vault-smoke
```

Walk through prompts:
- vault location → accept default or `/tmp/vault-smoke`
- gh prompt → answer NO for first smoke (avoid pushing to a real remote)
- obsidian name → `void`
- confirm → yes

Expected output:
- preflight prints detected versions of bun + claude
- bun install runs at root + plugin
- plugin build runs (or skipped if dist current)
- seed creates `/tmp/vault-smoke/CLAUDE.md`, `agents/tinker/agent.md`, `.void`, `.git/`
- plugin copied to `/tmp/vault-smoke/.obsidian/plugins/void-os/`
- final "void-os seeded at /tmp/vault-smoke" report block

Verify:

```bash
cat /tmp/vault-smoke/.void
ls -la /tmp/vault-smoke/.git/HEAD
ls /tmp/vault-smoke/agents/
ls /tmp/vault-smoke/.obsidian/plugins/void-os/
```

- [ ] **Step 12.3: Re-run without `--force`**

```bash
VOID_OS_PREFIX=$PWD void-os init --home /tmp/vault-smoke
```

Expected:
- preflight + build + plugin re-run
- seed reports "already seeded; re-applied build + plugin only"
- no new git commit
- `CLAUDE.md` not overwritten if you edited it

Edit `CLAUDE.md`, re-run, confirm edit survives:

```bash
echo "USER EDIT" >> /tmp/vault-smoke/CLAUDE.md
VOID_OS_PREFIX=$PWD void-os init --home /tmp/vault-smoke
tail -1 /tmp/vault-smoke/CLAUDE.md
# Should still say USER EDIT
```

- [ ] **Step 12.4: Re-run with `--force`**

```bash
VOID_OS_PREFIX=$PWD void-os init --home /tmp/vault-smoke --force
tail -1 /tmp/vault-smoke/CLAUDE.md
# Should NOT say USER EDIT — overwritten by seed
git -C /tmp/vault-smoke log --oneline
# Should still show only one commit ("seed: void-os init") — no new auto-commit on re-run
```

- [ ] **Step 12.5: Cleanup**

```bash
rm -rf /tmp/vault-smoke
```

- [ ] **Step 12.6: Record results in task work log**

Use `sw_run` (from the orchestrator) to append manual-smoke results to the task file `## Work Log`. No code commit.

---

## Task 13: Update task file acceptance bullets

**Files:**
- Modify: `vault/work/tasks/active/VOS-119-void-os-init-installer.md` (via `sw_run`)

- [ ] **Step 13.1: Replace acceptance section**

Run, from the orchestrator:

```bash
tools/state-write/sw "task(VOS-119): acceptance bullets revised per spec" -- bash -c '
set -e
cd /Users/admin/hub
f=$(ls vault/work/tasks/active/VOS-119-*.md | head -1)
python3 - <<PY
import pathlib, re
p = pathlib.Path("$f" if False else "'"$f"'")
text = p.read_text()
new_accept = """## Acceptance

- [ ] \`void-os init\` runs interactively via \`@clack/prompts\`: vault location (default \`~/vault\`), GH repo name (if gh authed), Obsidian vault name (if Obsidian found).
- [ ] Preflight detects + reports os, claude CLI, bun, gh auth, Obsidian. Hard-fails on missing claude or bun (with \`brew install bun\` offer on Mac).
- [ ] Build step: \`bun install\` at root + \`bun install && bun run build\` inside \`plugin/\`. Skips plugin build if dist is current (incl. plugin/package.json + bun.lockb in mtime check).
- [ ] Seed: creates vault dir, copies \`starter-vault/\` (CLAUDE.md + \`agents/tinker/agent.md\` + empty \`log.md\` + README), writes \`.void\` JSON marker, \`git init\` + first commit (only on fresh seed), optional \`gh repo create --private --push\`.
- [ ] Plugin install: copies \`plugin/dist/\` to \`<vault>/.obsidian/plugins/void-os/\`. Prints enable steps if Obsidian detected.
- [ ] Final report: 'ready' message with Obsidian enable hint + note that CLI \`void-os ask tinker "hello"\` lands with VOS-118.
- [ ] Re-running on an already-initialized vault is safe (detects \`.void\` file marker, skips seed unless \`--force\`, never auto-commits user WIP).
- [ ] Seed templates live in \`starter-vault/\` and are version-controlled.
- [ ] \`starter-vault/CLAUDE.md\` encodes wiki schema + agent system primer per migration spec.
- [ ] Existing \`maya\`, \`journaler\`, \`task-tracker\` seed agents removed; replaced with single \`tinker\` agent.
- [ ] gh push never auto-rewrites an existing \`origin\`; aborts with warn if mismatched.
"""
text = re.sub(r"## Acceptance\n.*?(?=\n## )", new_accept + "\n", text, count=1, flags=re.S)
p.write_text(text)
PY
git add "$f"
'
```

(The orchestrator can also write this block inline by reading the file and using Edit; the `sw_run` form is shown above for parity with `/work` conventions.)

- [ ] **Step 13.2: No commit needed (sw_run committed already)**

---

## Self-review summary

**Spec coverage:**
- Phases — Tasks 3, 4, 5, 6, 7 (preflight, configure, build, seed, plugin)
- Prompter mandate — Task 2
- Re-run guards — Task 6
- gh existing-remote safety — Task 6
- Build skip with lockfile — Task 5
- `.void` JSON marker without `vault` field — Task 6
- Tinker seed content — Task 9
- Drop maya/journaler/task-tracker — Task 10
- End-to-end integration — Task 11
- Manual smoke — Task 12
- Acceptance bullet rewrite — Task 13

**Placeholder scan:** none. Every code step has complete code; every command has expected output described.

**Type consistency:** `SeedOpts.gh` is `{ push: boolean; repoName?: string }` everywhere; `Decisions.gh` is the same type via the `GhDecision` interface. `PreflightReport` and `Decisions` types are imported/exported consistently. `ScriptedPrompter` matches the `Prompter` interface.

**Known carryover:** Legacy `cli/init.test.ts` keeps importing `provision` from `./init` (re-exported from `./init/seed`) so external callers and old tests don't break. The legacy fixture had `.void/` as a directory — Task 6.1 rewrites that.
