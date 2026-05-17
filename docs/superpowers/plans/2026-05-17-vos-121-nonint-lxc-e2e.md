# VOS-121 — `--non-interactive` init + LXC E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `void-os init --non-interactive` (driven entirely by CLI flags, no prompts) and an automated end-to-end test that provisions a fresh Proxmox LXC on `tower`, installs the stack, asks Tinker to write a file, asserts vault state — runnable locally and from a self-hosted GitHub Actions runner.

**Architecture:**
1. Extend `cli/init.ts` flag parser + add `decideFromFlags()` alongside the existing interactive `configure()`, branching in `initCommand()`.
2. New `e2e/lxc/` tree (`lib/{lxc,rsync,setup,diagnostics}.ts` + one `init-non-interactive.spec.ts` + `run.sh` + README + `.claudev-version` pin) drives Proxmox LXCs on tower over `ssh root@tower` calling a sudoers-scoped `vos-pct` allowlist wrapper.
3. CI runs on a self-hosted GH runner LXC provisioned by a new Ansible role in `workspace/homelab`; workflow triggers on PRs touching init or e2e paths.

**Tech Stack:** TypeScript (Bun runtime, `bun:test`), POSIX shell, Proxmox `pct`, `flock`, Ansible (`community.general.proxmox`), GitHub Actions (self-hosted), claudev (pinned).

**Spec:** `docs/superpowers/plans/../specs/2026-05-17-vos-121-nonint-lxc-e2e-design.md` (canonical).

---

## Task 0a: Probe — void-auth admin API for minting access codes

**Why:** Spec Risk #1: the endpoint shape (`POST /v1/admin/access-codes`, response `{code}`) is unverified. If wrong, `tools/mint-claudev-code.sh` and the CI workflow are broken. T0a finalizes the script.

**Files:**
- Read: `/Users/admin/hub-wt/VOS-121/workspace/void-auth/src/**` (find admin routes)
- Read: `/Users/admin/hub-wt/VOS-121/workspace/void-auth/CLAUDE.md`
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/docs/superpowers/specs/2026-05-17-vos-121-nonint-lxc-e2e-design.md` — finalize Component 3 script with real endpoint shape

- [ ] **Step 1: Locate void-auth admin code-mint endpoint**

```bash
grep -rEn 'access[-_]?codes?|admin.*code|/v1/admin' /Users/admin/hub-wt/VOS-121/workspace/void-auth/src/ /Users/admin/hub-wt/VOS-121/workspace/void-auth/routes/ 2>/dev/null
```

Expected: at least one route handler matching `/admin/.*access.*code` style. Read the matching file to extract: HTTP method, exact path, auth header expected, request body schema, response shape.

- [ ] **Step 2: Verify admin auth mechanism**

```bash
grep -rEn 'VOID_AUTH_ADMIN_TOKEN|admin.*bearer|requireAdmin|adminMiddleware' /Users/admin/hub-wt/VOS-121/workspace/void-auth/src/ 2>/dev/null
```

Expected: confirm the admin token env var name and how it's checked. If the env var is different from `VOID_AUTH_ADMIN_TOKEN`, record the real name.

- [ ] **Step 3: Confirm code format + ttl options**

Read the mint handler to confirm: returned code format (`XXXX-XXXX`?), whether ttl_seconds is accepted, what `purpose`/`label` field name is used (if any).

- [ ] **Step 4: Write findings to spec**

Edit the spec file's Component 3 block: replace the placeholder script with the exact verified curl + jq/python parse. If the endpoint is missing entirely, STOP this plan and create a `VAU-N` task to add it; VOS-121 blocks on it.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add docs/superpowers/specs/2026-05-17-vos-121-nonint-lxc-e2e-design.md
git commit -m "task(VOS-121): T0a verified void-auth mint endpoint, finalized Component 3 script"
```

---

## Task 0b: Probe — does `void-os init` auto-start the daemon?

**Why:** Spec Risk #2: the e2e spec currently asserts `void-os daemon status` after init. If init does NOT auto-start the daemon, status will fail and the test never runs `ask tinker`. T0b picks the binding contract.

**Files:**
- Read: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init.ts`
- Read: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init/*.ts`
- Read: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/daemon.ts`
- Modify: spec file (same path) — record the resolved contract

- [ ] **Step 1: Trace init.ts daemon-start path**

```bash
grep -nE 'daemon|spawn|start' /Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init.ts /Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init/*.ts
```

Expected: identify whether `initCommand()` ends by spawning the daemon, or whether the user runs `void-os daemon start` separately. Note the file:line.

- [ ] **Step 2: Manual confirmation on host**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
TMPDIR=$(mktemp -d) bun cli/init.ts --non-interactive --vault "$TMPDIR/vault" 2>&1 | tail -20
# (Will fail if --non-interactive isn't wired yet — okay, T1 builds it. Use existing interactive path:)
# Or in absence of T1, use the existing test harness:
bun test cli/init.e2e.test.ts -t "fresh install" 2>&1 | tail -30
ps aux | grep -i 'void-os.*daemon' | grep -v grep
```

Expected: confirm whether a daemon process is running after init exits cleanly.

- [ ] **Step 3: Update spec to bind the contract**

In `init-non-interactive.spec.ts` block of the spec, replace the placeholder daemon-check with the resolved branch:

If auto-starts: keep `void-os daemon status` assertion (exit 0).

If does not auto-start: replace with `void-os daemon start` (require exit 0) + then status check. Add a sub-bullet under Risks #2 marking it RESOLVED with the chosen branch.

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add docs/superpowers/specs/2026-05-17-vos-121-nonint-lxc-e2e-design.md
git commit -m "task(VOS-121): T0b resolved daemon-start contract; spec updated"
```

---

## Task 1: Flag parsing for `--non-interactive` and friends

**Files:**
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init.ts` — extend `Flags` interface + `parseFlags()`
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init.test.ts` — new test cases (file already exists per the explore phase listing)

- [ ] **Step 1: Write failing test for `--non-interactive` flag parsing**

Append to `cli/init.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import { parseFlags } from "./init"

describe("parseFlags non-interactive", () => {
  test("--non-interactive sets nonInteractive=true", () => {
    const f = parseFlags(["--non-interactive", "--vault", "/tmp/v"])
    expect(f.nonInteractive).toBe(true)
    expect(f.vault).toBe("/tmp/v")
  })

  test("--gh-repo X parsed", () => {
    const f = parseFlags(["--non-interactive", "--vault", "/tmp/v", "--gh-repo", "myvault"])
    expect(f.ghRepo).toBe("myvault")
    expect(f.skipGh).toBe(false)
  })

  test("--skip-gh parsed", () => {
    const f = parseFlags(["--non-interactive", "--vault", "/tmp/v", "--skip-gh"])
    expect(f.skipGh).toBe(true)
  })

  test("--skip-obsidian and --obsidian-vault parsed", () => {
    const f = parseFlags([
      "--non-interactive", "--vault", "/tmp/v",
      "--obsidian-vault", "myvault",
    ])
    expect(f.obsidianVault).toBe("myvault")
    expect(f.skipObsidian).toBe(false)

    const g = parseFlags(["--non-interactive", "--vault", "/tmp/v", "--skip-obsidian"])
    expect(g.skipObsidian).toBe(true)
  })
})
```

Note: `parseFlags` is currently not exported from `cli/init.ts`. The implementation step exports it.

- [ ] **Step 2: Run tests to verify failure**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test cli/init.test.ts -t "parseFlags non-interactive" 2>&1 | tail -20
```

Expected: FAIL with import error on `parseFlags` (not exported) OR property errors on `nonInteractive`/`vault`/`ghRepo`.

- [ ] **Step 3: Extend Flags interface + parseFlags**

Edit `cli/init.ts`. Locate the existing `interface Flags` block and extend:

```ts
interface Flags {
  home?: string
  dryRun: boolean
  force: boolean
  skipBuild: boolean
  // New:
  nonInteractive: boolean
  vault?: string
  ghRepo?: string
  skipGh: boolean
  skipObsidian: boolean
  obsidianVault?: string
}

export function parseFlags(args: string[]): Flags {
  const out: Flags = {
    dryRun: false, force: false, skipBuild: false,
    nonInteractive: false, skipGh: false, skipObsidian: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--force") out.force = true
    else if (a === "--skip-build") out.skipBuild = true
    else if (a === "--home") out.home = args[++i]
    else if (a === "--non-interactive") out.nonInteractive = true
    else if (a === "--vault") out.vault = args[++i]
    else if (a === "--gh-repo") out.ghRepo = args[++i]
    else if (a === "--skip-gh") out.skipGh = true
    else if (a === "--skip-obsidian") out.skipObsidian = true
    else if (a === "--obsidian-vault") out.obsidianVault = args[++i]
  }
  return out
}
```

(If `parseFlags` already exists and has slightly different shape, integrate the new fields and rename `export` if needed. Preserve existing `home`, `dryRun`, etc.)

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test cli/init.test.ts -t "parseFlags non-interactive" 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add cli/init.ts cli/init.test.ts
git commit -m "task(VOS-121): T1 add --non-interactive + companion flag parsing"
```

---

## Task 2: Flag validation (mutex + required)

**Files:**
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init.ts` — add `validateFlags()` called by `initCommand` before any IO
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init.test.ts`

- [ ] **Step 1: Write failing tests for validation**

Append to `cli/init.test.ts`:

```ts
import { validateFlags, FlagsError } from "./init"

describe("validateFlags", () => {
  test("--non-interactive without --vault throws exit 64", () => {
    expect(() => validateFlags(parseFlags(["--non-interactive"])))
      .toThrow(FlagsError)
    try { validateFlags(parseFlags(["--non-interactive"])) }
    catch (e) {
      expect(e).toBeInstanceOf(FlagsError)
      expect((e as FlagsError).exitCode).toBe(64)
      expect((e as FlagsError).message).toMatch(/--non-interactive requires --vault/)
    }
  })

  test("--gh-repo + --skip-gh mutually exclusive (exit 64)", () => {
    try {
      validateFlags(parseFlags([
        "--non-interactive", "--vault", "/tmp/v",
        "--gh-repo", "x", "--skip-gh",
      ]))
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(FlagsError)
      expect((e as FlagsError).exitCode).toBe(64)
      expect((e as FlagsError).message).toMatch(/mutually exclusive/)
    }
  })

  test("valid --non-interactive --vault X passes", () => {
    expect(() => validateFlags(parseFlags([
      "--non-interactive", "--vault", "/tmp/v",
    ]))).not.toThrow()
  })

  test("interactive mode (no --non-interactive) passes without --vault", () => {
    expect(() => validateFlags(parseFlags([]))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test cli/init.test.ts -t "validateFlags" 2>&1 | tail -25
```

Expected: FAIL — `validateFlags` and `FlagsError` not exported.

- [ ] **Step 3: Add validateFlags + FlagsError to init.ts**

In `cli/init.ts`, add near the top (or after `parseFlags`):

```ts
export class FlagsError extends Error {
  constructor(msg: string, public exitCode: number) { super(msg) }
}

export function validateFlags(f: Flags): void {
  if (f.nonInteractive && !f.vault) {
    throw new FlagsError("--non-interactive requires --vault <path>", 64)
  }
  if (f.ghRepo && f.skipGh) {
    throw new FlagsError("--gh-repo and --skip-gh are mutually exclusive", 64)
  }
}
```

The gh-not-available check (exit 65) happens later in T3 because it needs the preflight report.

- [ ] **Step 4: Run to verify pass**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test cli/init.test.ts -t "validateFlags" 2>&1 | tail -15
```

Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add cli/init.ts cli/init.test.ts
git commit -m "task(VOS-121): T2 validateFlags with FlagsError exit codes"
```

---

## Task 3: `decideFromFlags()` — non-interactive path

**Files:**
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init/configure.ts` — add export
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init/configure.test.ts` — append cases

- [ ] **Step 1: Write failing tests**

Append to `cli/init/configure.test.ts`:

```ts
import { decideFromFlags } from "./configure"
import type { PreflightReport } from "./preflight"

const baseReport: PreflightReport = {
  os: "linux",
  claude: { found: true },
  bun: { found: true },
  gh: { found: false, authed: false },
  obsidian: { found: false },
}

describe("decideFromFlags", () => {
  test("vault path expansion (~/foo → home)", () => {
    const d = decideFromFlags(baseReport, {
      nonInteractive: true, vault: "~/foo",
      skipGh: false, skipObsidian: false,
      dryRun: false, force: false, skipBuild: false,
    })
    expect(d.vaultPath).toBe(require("node:os").homedir() + "/foo")
    expect(d.gh.push).toBe(false)
    expect(d.cancelled).toBe(false)
  })

  test("--gh-repo X with gh available → push true", () => {
    const r = { ...baseReport, gh: { found: true, authed: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v", ghRepo: "myrepo",
      skipGh: false, skipObsidian: false,
      dryRun: false, force: false, skipBuild: false,
    })
    expect(d.gh).toEqual({ push: true, repoName: "myrepo" })
  })

  test("--gh-repo X with gh NOT available → throws FlagsError exit 65", () => {
    const r = { ...baseReport, gh: { found: false, authed: false } }
    expect(() => decideFromFlags(r, {
      nonInteractive: true, vault: "/v", ghRepo: "myrepo",
      skipGh: false, skipObsidian: false,
      dryRun: false, force: false, skipBuild: false,
    })).toThrow(/gh not available/)
  })

  test("--skip-obsidian → undefined obsidianVaultName even if obsidian detected", () => {
    const r = { ...baseReport, obsidian: { found: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v", skipObsidian: true,
      skipGh: false, dryRun: false, force: false, skipBuild: false,
    })
    expect(d.obsidianVaultName).toBeUndefined()
  })

  test("obsidian detected + no skip + no override → default \"void\"", () => {
    const r = { ...baseReport, obsidian: { found: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v",
      skipGh: false, skipObsidian: false,
      dryRun: false, force: false, skipBuild: false,
    })
    expect(d.obsidianVaultName).toBe("void")
  })

  test("--obsidian-vault X overrides default", () => {
    const r = { ...baseReport, obsidian: { found: true } }
    const d = decideFromFlags(r, {
      nonInteractive: true, vault: "/v", obsidianVault: "custom",
      skipGh: false, skipObsidian: false,
      dryRun: false, force: false, skipBuild: false,
    })
    expect(d.obsidianVaultName).toBe("custom")
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test cli/init/configure.test.ts -t "decideFromFlags" 2>&1 | tail -30
```

Expected: FAIL — `decideFromFlags` not exported.

- [ ] **Step 3: Implement decideFromFlags**

Edit `cli/init/configure.ts`. Add at the bottom, alongside `configure()`:

```ts
import { FlagsError } from "../init"  // adjust relative path

export interface NonInteractiveFlags {
  nonInteractive: boolean
  vault?: string
  ghRepo?: string
  skipGh: boolean
  skipObsidian: boolean
  obsidianVault?: string
}

export function decideFromFlags(
  report: PreflightReport,
  flags: NonInteractiveFlags,
): Decisions {
  if (!flags.vault) {
    throw new FlagsError("--non-interactive requires --vault <path>", 64)
  }
  const vaultPath = expandHome(flags.vault)

  let gh: GhDecision = { push: false }
  if (flags.ghRepo) {
    if (!report.gh.found || !report.gh.authed) {
      throw new FlagsError(
        "gh not available (not installed or not authed); remove --gh-repo or fix gh first",
        65,
      )
    }
    gh = { push: true, repoName: flags.ghRepo }
  }

  let obsidianVaultName: string | undefined
  if (!flags.skipObsidian) {
    obsidianVaultName = flags.obsidianVault
      ?? (report.obsidian.found ? "void" : undefined)
  }

  return { vaultPath, gh, obsidianVaultName, cancelled: false }
}
```

If `expandHome` is module-private, export it or duplicate the small function. Don't re-export from `init.ts` (would create a cycle — instead move `expandHome` into a shared `paths.ts` module if needed). For initial implementation: copy the 4-line `expandHome` inline.

- [ ] **Step 4: Run to verify pass**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test cli/init/configure.test.ts -t "decideFromFlags" 2>&1 | tail -15
```

Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add cli/init/configure.ts cli/init/configure.test.ts
git commit -m "task(VOS-121): T3 decideFromFlags non-interactive path"
```

---

## Task 4: Wire non-interactive branch into `initCommand`

**Files:**
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init.ts` — branch in initCommand, swap configure() for decideFromFlags() when flag set, and silence the bun-install brew prompt
- Modify: `/Users/admin/hub-wt/VOS-121/workspace/void-os/cli/init.e2e.test.ts` — add black-box non-interactive case

- [ ] **Step 1: Write failing e2e test (file-system black box)**

Append a new `describe` block to `cli/init.e2e.test.ts` (reuse existing fixtures):

```ts
describe("initCommand() --non-interactive", () => {
  it("runs end-to-end with flag-only config, never prompts", async () => {
    setupPrefixWithRealStarter()
    const prompter = new ScriptedPrompter({ text: [], confirm: [] })

    await initCommand({
      args: ["--non-interactive", "--vault", home, "--skip-gh", "--skip-obsidian"],
      prefix,
      prompter,                      // empty-queue: any prompt would throw
      preflight: fakePreflight,
      skipBuild: true,
    })

    expect(existsSync(home)).toBe(true)
    expect(existsSync(join(home, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(home, ".void"))).toBe(true)
    // No `intro:`/`outro:` log entries since prompter never invoked:
    expect(prompter.log.length).toBe(0)
  })

  it("missing --vault under --non-interactive exits 64", async () => {
    setupPrefixWithRealStarter()
    const prompter = new ScriptedPrompter({ text: [], confirm: [] })
    const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error(`exit:${c}`)
    }) as never)
    const errSpy = spyOn(console, "error").mockImplementation(() => {})

    try {
      await initCommand({
        args: ["--non-interactive"],
        prefix,
        prompter,
        preflight: fakePreflight,
        skipBuild: true,
      })
      throw new Error("should have exited")
    } catch (e) {
      expect((e as Error).message).toBe("exit:64")
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test cli/init.e2e.test.ts -t "non-interactive" 2>&1 | tail -25
```

Expected: FAIL — `initCommand` doesn't recognize `--non-interactive` yet; will likely fall through to `configure()` and fail when the empty scripted queue is pulled, OR fail when `decideFromFlags` is not wired.

- [ ] **Step 3: Wire the branch in initCommand**

Edit `cli/init.ts`. Inside `initCommand()`, after `parseFlags()`, before any IO:

```ts
const flags = parseFlags(opts.args)
try {
  validateFlags(flags)
} catch (e) {
  if (e instanceof FlagsError) {
    console.error(e.message)
    process.exit(e.exitCode)
    return
  }
  throw e
}
```

Replace the `// 2. CONFIGURE` block with:

```ts
// 2. CONFIGURE
let decisions: Decisions
if (flags.nonInteractive) {
  try {
    decisions = decideFromFlags(report, flags)
  } catch (e) {
    if (e instanceof FlagsError) {
      console.error(e.message)
      process.exit(e.exitCode)
      return
    }
    throw e
  }
} else {
  decisions = await configure(report, prompter)
  if (decisions.cancelled) {
    console.error("cancelled")
    process.exit(130)
    return
  }
}
```

In the preflight `enforce()` call, when `flags.nonInteractive` is true, pass a no-op brew-prompt:

```ts
const offerBrewInstallBun = flags.nonInteractive
  ? () => false
  : (opts.offerBrewInstallBun ?? defaultBrewPrompt)
enforce(report, { offerBrewInstallBun })
```

Add the `decideFromFlags` import at the top:

```ts
import { configure, decideFromFlags } from "./init/configure"
```

- [ ] **Step 4: Run to verify pass**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test cli/init.e2e.test.ts -t "non-interactive" 2>&1 | tail -25
bun test cli/init.test.ts 2>&1 | tail -10        # regression check
bun test cli/init.e2e.test.ts 2>&1 | tail -10    # full e2e regression
```

Expected: all PASS (2 new + all existing).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add cli/init.ts cli/init.e2e.test.ts
git commit -m "task(VOS-121): T4 wire --non-interactive branch into initCommand"
```

---

## Task 5: `vos-pct` allowlist wrapper script (homelab)

**Why:** Spec security fix #4. Sudoers must scope `pct` invocations to CTID range `[9100, 9199]` plus the runner-LXC bootstrap CTID `198`. This task lives in the homelab repo (NOT void-os), because it's deployed via Ansible to tower.

**Worktree note:** This task touches `workspace/homelab` files via gitlink. Cd into the actual repo (`/Users/admin/hub-wt/VOS-121/workspace/homelab` follows the gitlink to a separate checkout). Commit there directly (per `feedback_homelab_direct_to_main`).

**Files:**
- Create: `/Users/admin/hub-wt/VOS-121/workspace/homelab/ansible/roles/gh-runner-vos/files/vos-pct`
- Create: `/Users/admin/hub-wt/VOS-121/workspace/homelab/ansible/roles/gh-runner-vos/files/test-vos-pct.sh` (host-runnable smoke)

- [ ] **Step 1: Write the wrapper**

Create `workspace/homelab/ansible/roles/gh-runner-vos/files/vos-pct`:

```sh
#!/bin/sh
# vos-pct — sudoers-allowlisted wrapper around /usr/sbin/pct.
# Validates the CTID argument is in the VOS E2E reserved range OR is the
# runner-LXC bootstrap CTID. Rejects everything else with exit 2.

set -eu

ALLOW_MIN=9100
ALLOW_MAX=9199
RUNNER_CTID=198

reject() {
  printf 'vos-pct: rejected: %s\n' "$*" >&2
  logger -t vos-pct "rejected: $*" || true
  exit 2
}

[ "$#" -ge 1 ] || reject "no arguments"

# pct subcommands take CTID as the FIRST positional after the subcommand,
# except `list`, `cluster`, `help` which take none. Whitelist subcommands
# that operate on a CTID.
sub="$1"
shift || true

case "$sub" in
  list|help|--help|-h|--version)
    exec /usr/sbin/pct "$sub" "$@"
    ;;
  create|destroy|start|stop|status|exec|push|pull|enter|set|config|reboot|shutdown|fsck|migrate|mount|unmount|clone|template|cpusets|listsnapshot|rollback|snapshot|delsnapshot|resize|unlock)
    [ "$#" -ge 1 ] || reject "$sub requires CTID"
    ctid="$1"
    case "$ctid" in
      ''|*[!0-9]*) reject "non-numeric CTID: $ctid" ;;
    esac
    if [ "$ctid" -eq "$RUNNER_CTID" ]; then
      exec /usr/sbin/pct "$sub" "$@"
    elif [ "$ctid" -ge "$ALLOW_MIN" ] && [ "$ctid" -le "$ALLOW_MAX" ]; then
      exec /usr/sbin/pct "$sub" "$@"
    else
      reject "CTID $ctid not in allowlist ([$ALLOW_MIN-$ALLOW_MAX] or $RUNNER_CTID)"
    fi
    ;;
  *)
    reject "subcommand not in allowlist: $sub"
    ;;
esac
```

- [ ] **Step 2: Write a host-runnable smoke script (no /usr/sbin/pct needed for negative cases)**

Create `workspace/homelab/ansible/roles/gh-runner-vos/files/test-vos-pct.sh`:

```sh
#!/bin/sh
# Smoke test for vos-pct. Runs the wrapper with various inputs and asserts
# exit code + stderr pattern. Stubs /usr/sbin/pct via PATH override so we
# never invoke the real binary.

set -eu
HERE=$(dirname "$0")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Stub pct: prints "STUB OK $*" and exits 0.
mkdir -p "$TMP/sbin"
cat > "$TMP/sbin/pct" <<'EOF'
#!/bin/sh
echo "STUB OK $*"
EOF
chmod +x "$TMP/sbin/pct"

# Patch the wrapper to use the stub by overriding /usr/sbin via a sed copy.
sed 's|/usr/sbin/pct|'"$TMP/sbin/pct"'|g' "$HERE/vos-pct" > "$TMP/vos-pct"
chmod +x "$TMP/vos-pct"

pass=0; fail=0
expect() {
  desc="$1"; shift
  want_exit="$1"; shift
  want_re="$1"; shift
  out=$("$TMP/vos-pct" "$@" 2>&1) || true
  got=$?
  if [ "$got" -eq "$want_exit" ] && echo "$out" | grep -qE "$want_re"; then
    echo "ok   $desc"; pass=$((pass+1))
  else
    echo "FAIL $desc (exit=$got want=$want_exit out=$out)"; fail=$((fail+1))
  fi
}

expect "allow CTID in range"            0 "STUB OK"        create 9100 -ostemplate xxx
expect "allow runner CTID 198"          0 "STUB OK"        status 198
expect "reject CTID below range"        2 "not in allow"   destroy 100
expect "reject CTID above range"        2 "not in allow"   destroy 9200
expect "reject non-numeric CTID"        2 "non-numeric"    exec foo -- bash -c true
expect "reject unknown subcommand"      2 "not in allow"   delete-cluster
expect "allow list (no CTID)"           0 "STUB OK"        list

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 3: Run smoke**

```bash
chmod +x /Users/admin/hub-wt/VOS-121/workspace/homelab/ansible/roles/gh-runner-vos/files/vos-pct
chmod +x /Users/admin/hub-wt/VOS-121/workspace/homelab/ansible/roles/gh-runner-vos/files/test-vos-pct.sh
/Users/admin/hub-wt/VOS-121/workspace/homelab/ansible/roles/gh-runner-vos/files/test-vos-pct.sh
```

Expected: `7 passed, 0 failed`.

- [ ] **Step 4: Commit (in homelab repo, direct to main)**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/homelab
git add ansible/roles/gh-runner-vos/files/vos-pct ansible/roles/gh-runner-vos/files/test-vos-pct.sh
git commit -m "feat(gh-runner-vos): vos-pct allowlist wrapper for VOS-121 LXC E2E"
```

---

## Task 6: `lib/lxc.ts` — provision/exec/destroy with flock

**Files:**
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/lib/lxc.ts`
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/lib/lxc.test.ts`

**Approach:** TDD for the pure helpers (CTID-pick parsing); for ssh-side ops we test by injecting a mock `runSsh` runner. Real LXC behavior is exercised by the E2E spec in T10.

- [ ] **Step 1: Write failing tests for `pickFreeCtid` (pure function)**

Create `e2e/lxc/lib/lxc.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { pickFreeCtid } from "./lxc"

const pctListOutput = `VMID       Status     Lock         Name
100        running                 mcow-svc
198        running                 gh-runner-vos
9100       stopped                 vos-e2e-aaa
9102       stopped                 vos-e2e-bbb
`

describe("pickFreeCtid (max-in-range + 1)", () => {
  test("returns max-used-in-range + 1", () => {
    const ctid = pickFreeCtid(pctListOutput, [9100, 9199])
    expect(ctid).toBe(9103)  // max in range is 9102, so next is 9103
  })

  test("returns range start when range fully unused", () => {
    expect(pickFreeCtid("VMID Status\n", [9100, 9199])).toBe(9100)
  })

  test("ignores CTIDs outside range when computing max", () => {
    expect(pickFreeCtid("VMID\n100 stopped\n198 running\n", [9100, 9199])).toBe(9100)
  })

  test("throws when max+1 would exceed range", () => {
    expect(() => pickFreeCtid("VMID\n9199 stopped\n", [9100, 9199])).toThrow(/no free CTID/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
mkdir -p e2e/lxc/lib
bun test e2e/lxc/lib/lxc.test.ts 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/lxc.ts`**

Create `e2e/lxc/lib/lxc.ts`:

```ts
import { spawn } from "node:child_process"

export interface LxcHandle { ctid: number; hostname: string; towerHost: string }

export interface ExecResult { stdout: string; stderr: string; exitCode: number }

export type SshRunner = (host: string, cmd: string, opts?: { timeoutMs?: number }) => Promise<ExecResult>

// --- pure parser, unit-tested ---

// Picks max(used ∩ range) + 1, or range start when range is empty.
// Matches the awk one-liner in the provisionLxc shell snippet — one contract.
export function pickFreeCtid(pctListOut: string, range: [number, number]): number {
  let maxInRange = -1
  for (const line of pctListOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const n = Number(m[1])
    if (n >= range[0] && n <= range[1] && n > maxInRange) maxInRange = n
  }
  const next = maxInRange === -1 ? range[0] : maxInRange + 1
  if (next > range[1]) throw new Error(`no free CTID in [${range[0]}, ${range[1]}]`)
  return next
}

// --- ssh runner ---

export const defaultSshRunner: SshRunner = (host, cmd, opts) =>
  new Promise((resolve) => {
    const p = spawn("ssh", [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      host, cmd,
    ])
    let stdout = "", stderr = ""
    p.stdout.on("data", (d) => { stdout += d.toString() })
    p.stderr.on("data", (d) => { stderr += d.toString() })
    let timed = false
    const timer = opts?.timeoutMs
      ? setTimeout(() => { timed = true; p.kill("SIGKILL") }, opts.timeoutMs)
      : null
    p.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        stdout, stderr,
        exitCode: timed ? 124 : (code ?? -1),
      })
    })
  })

// --- LXC operations ---

const PCT = "sudo /usr/local/sbin/vos-pct"   // sudoers-scoped wrapper
const LOCK = "/var/lock/vos-e2e-ctid"

export async function provisionLxc(opts: {
  template?: string
  ctidRange?: [number, number]
  towerHost?: string
  ssh?: SshRunner
} = {}): Promise<LxcHandle> {
  const template = opts.template ?? "debian-12-standard"
  const range = opts.ctidRange ?? [9100, 9199]
  const towerHost = opts.towerHost ?? process.env.TOWER_HOST ?? "tower"
  const ssh = opts.ssh ?? defaultSshRunner
  const suffix = Math.random().toString(36).slice(2, 8)
  const hostname = `vos-e2e-${suffix}`

  // Pick + create under flock to serialize concurrent callers.
  // Pick CTID, then attempt create; on collision, retry once.
  const pickAndCreate = `
flock /var/lock/vos-e2e-ctid -c '
  list=$(${PCT} list)
  ctid=$(echo "$list" | awk "NR>1 && \\$1 >= ${range[0]} && \\$1 <= ${range[1]} {print \\$1}" | sort -n | tail -1)
  if [ -z "$ctid" ]; then ctid=${range[0]}; else ctid=$((ctid + 1)); fi
  if [ "$ctid" -gt ${range[1]} ]; then echo "no free CTID" >&2; exit 1; fi
  ${PCT} create $ctid local:vztmpl/${template}.tar.zst \\
    --hostname ${hostname} \\
    --memory 1024 --cores 2 --rootfs local-lvm:8 \\
    --features nesting=1 --unprivileged 1 \\
    --net0 name=eth0,bridge=vmbr0,ip=dhcp \\
    --start 1
  echo CTID=$ctid
'
`
  const r = await ssh(`root@${towerHost}`, pickAndCreate, { timeoutMs: 60_000 })
  if (r.exitCode !== 0) {
    throw new Error(`provisionLxc failed: ${r.stderr || r.stdout}`)
  }
  const m = r.stdout.match(/CTID=(\d+)/)
  if (!m) throw new Error(`provisionLxc: could not parse CTID from output: ${r.stdout}`)
  return { ctid: Number(m[1]), hostname, towerHost }
}

export async function lxcExec(
  h: LxcHandle,
  cmd: string,
  opts: { timeoutMs?: number; allowFailure?: boolean; ssh?: SshRunner } = {},
): Promise<ExecResult> {
  const ssh = opts.ssh ?? defaultSshRunner
  // base64 the cmd so quoting never breaks.
  const b64 = Buffer.from(cmd).toString("base64")
  const wrapped = `${PCT} exec ${h.ctid} -- bash -lc "echo ${b64} | base64 -d | bash"`
  const r = await ssh(`root@${h.towerHost}`, wrapped, { timeoutMs: opts.timeoutMs ?? 60_000 })
  if (r.exitCode !== 0 && !opts.allowFailure) {
    throw new Error(
      `lxcExec failed (exit ${r.exitCode}) cmd=${cmd.slice(0, 120)}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
    )
  }
  return r
}

export async function waitForNet(h: LxcHandle, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    const r = await lxcExec(h, "getent hosts deb.debian.org >/dev/null && echo OK || echo NO", { allowFailure: true })
    if (r.stdout.includes("OK")) return
    last = r.stdout + r.stderr
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error(`waitForNet timeout for CTID ${h.ctid}; last=${last}`)
}

export async function destroyLxc(h: LxcHandle, opts: { ssh?: SshRunner } = {}): Promise<void> {
  if (process.env.KEEP_LXC === "1") {
    console.warn(`KEEP_LXC=1 set; not destroying CTID ${h.ctid} (hostname ${h.hostname})`)
    return
  }
  const ssh = opts.ssh ?? defaultSshRunner
  await ssh(`root@${h.towerHost}`, `${PCT} stop ${h.ctid} --force || true; ${PCT} destroy ${h.ctid} --purge || true`, { timeoutMs: 30_000 })
}
```

- [ ] **Step 4: Run unit tests**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test e2e/lxc/lib/lxc.test.ts 2>&1 | tail -15
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add e2e/lxc/lib/lxc.ts e2e/lxc/lib/lxc.test.ts
git commit -m "task(VOS-121): T6 lib/lxc.ts provision/exec/destroy with flock + pickFreeCtid"
```

---

## Task 7: `lib/rsync.ts` — rsync host → tower → into LXC

**Files:**
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/lib/rsync.ts`

(No unit tests — pure shell-out; real exercise comes in T10.)

- [ ] **Step 1: Write `lib/rsync.ts`**

```ts
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LxcHandle } from "./lxc"
import { lxcExec } from "./lxc"

const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist", "tmp", "*.log"]

function runCmd(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args)
    let stdout = "", stderr = ""
    p.stdout.on("data", (d) => { stdout += d.toString() })
    p.stderr.on("data", (d) => { stderr += d.toString() })
    let timed = false
    const t = opts.timeoutMs ? setTimeout(() => { timed = true; p.kill("SIGKILL") }, opts.timeoutMs) : null
    p.on("close", (c) => { if (t) clearTimeout(t); resolve({ exitCode: timed ? 124 : (c ?? -1), stderr, stdout }) })
  })
}

export async function rsyncIntoLxc(
  localPath: string, h: LxcHandle, destPath: string,
  excludes: string[] = DEFAULT_EXCLUDES,
): Promise<void> {
  const stagingDir = `/tmp/vos-e2e-stage-${h.ctid}`
  // 1. rsync localPath → tower:stagingDir
  const exFlags = excludes.flatMap((e) => ["--exclude", e])
  const r1 = await runCmd("rsync", [
    "-aH", "--delete", ...exFlags,
    `${localPath}/`,
    `root@${h.towerHost}:${stagingDir}/`,
  ], { timeoutMs: 120_000 })
  if (r1.exitCode !== 0) throw new Error(`rsync host→tower failed: ${r1.stderr}`)

  // 2. tar the staging dir on tower, pct push tar into the LXC, untar.
  const tarName = `vos-e2e-${h.ctid}.tar.gz`
  const cmd = [
    `tar -czf /tmp/${tarName} -C ${stagingDir} .`,
    `sudo /usr/local/sbin/vos-pct push ${h.ctid} /tmp/${tarName} /tmp/${tarName}`,
    `sudo /usr/local/sbin/vos-pct exec ${h.ctid} -- bash -c 'mkdir -p ${destPath} && tar -xzf /tmp/${tarName} -C ${destPath} && rm /tmp/${tarName}'`,
    `rm /tmp/${tarName}`,
    `rm -rf ${stagingDir}`,
  ].join(" && ")
  const r2 = await runCmd("ssh", ["-o", "BatchMode=yes", `root@${h.towerHost}`, cmd], { timeoutMs: 60_000 })
  if (r2.exitCode !== 0) throw new Error(`pct push/untar failed: ${r2.stderr}`)
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun build --target=bun e2e/lxc/lib/rsync.ts --outdir=/tmp/typecheck 2>&1 | tail -10
```

Expected: builds clean (no type errors). Discard `/tmp/typecheck`.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add e2e/lxc/lib/rsync.ts
git commit -m "task(VOS-121): T7 lib/rsync.ts rsync+pct-push tarball pipeline"
```

---

## Task 8: `lib/setup.ts` + `.claudev-version` (pinned claudev install)

**Files:**
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/.claudev-version`
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/lib/setup.ts`

- [ ] **Step 1: Pin a claudev ref**

Find the current claudev tip:

```bash
git -C /Users/admin/hub/workspace/claudev rev-parse main 2>/dev/null || git -C /Users/admin/hub/workspace/claudev rev-parse HEAD
```

Take the short SHA (first 12 chars). Write it to the pin file:

Create `e2e/lxc/.claudev-version` with single line containing the SHA, no trailing whitespace. Example content (use the real SHA from above):

```
abc123def456
```

- [ ] **Step 2: Write `lib/setup.ts`**

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { LxcHandle } from "./lxc"
import { lxcExec } from "./lxc"

const CLAUDEV_PIN_FILE = join(import.meta.dir, "..", ".claudev-version")

export function getClaudevPin(): string {
  const raw = readFileSync(CLAUDEV_PIN_FILE, "utf8").trim()
  if (!raw) throw new Error(`empty pin in ${CLAUDEV_PIN_FILE}`)
  if (!/^[a-f0-9]{7,40}$/i.test(raw) && !/^v?[\d.]+/.test(raw)) {
    throw new Error(`invalid claudev pin in ${CLAUDEV_PIN_FILE}: ${raw}`)
  }
  return raw
}

export async function installBaseDeps(h: LxcHandle): Promise<void> {
  const pin = getClaudevPin()

  await lxcExec(h,
    `set -e
     export DEBIAN_FRONTEND=noninteractive
     apt-get update
     apt-get install -y curl git unzip ca-certificates`,
    { timeoutMs: 120_000 },
  )

  // Bun:
  await lxcExec(h,
    `set -e
     curl -fsSL https://bun.sh/install | bash
     ln -sf /root/.bun/bin/bun /usr/local/bin/bun`,
    { timeoutMs: 90_000 },
  )

  // Claudev pinned:
  await lxcExec(h,
    `set -e
     rm -rf /root/claudev
     git clone https://github.com/makscee/claudev /root/claudev
     cd /root/claudev && git checkout ${pin}
     ./install.sh`,
    { timeoutMs: 90_000 },
  )

  // Verify claude is on PATH (claudev shim):
  const v = await lxcExec(h, "which claude && claude --version 2>&1 | head -1", { allowFailure: true })
  if (v.exitCode !== 0) {
    throw new Error(`claudev install verification failed: ${v.stderr || v.stdout}`)
  }
}

export async function loginClaudev(h: LxcHandle, accessCode: string): Promise<void> {
  // Heredoc-pipe the code into claudev login. Token lands at /root/.claudev/token.
  await lxcExec(h,
    `printf '%s\\n' "${accessCode}" | claudev login`,
    { timeoutMs: 15_000 },
  )
  const ver = await lxcExec(h,
    `test -f /root/.claudev/token && head -c 7 /root/.claudev/token`,
    { allowFailure: true },
  )
  if (ver.exitCode !== 0 || !ver.stdout.startsWith("sk-ant-")) {
    throw new Error(`loginClaudev verification failed: token absent or wrong prefix (got "${ver.stdout}")`)
  }
}
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun build --target=bun e2e/lxc/lib/setup.ts --outdir=/tmp/typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add e2e/lxc/.claudev-version e2e/lxc/lib/setup.ts
git commit -m "task(VOS-121): T8 lib/setup.ts with pinned claudev install"
```

---

## Task 9: `lib/diagnostics.ts` — pre-destroy log capture

**Files:**
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/lib/diagnostics.ts`

- [ ] **Step 1: Write the module**

```ts
import type { LxcHandle } from "./lxc"
import { lxcExec, destroyLxc } from "./lxc"

const DUMPS: Array<[string, string]> = [
  ["daemon log",  "cat /root/.void-os/daemon.log 2>/dev/null | tail -200"],
  ["vault tree",  "find /root/vault -type f 2>/dev/null | head -50"],
  ["journalctl",  "journalctl -xe --no-pager 2>/dev/null | tail -100"],
  ["void-os ps",  "ps aux 2>/dev/null | grep -E 'void-os|bun' | grep -v grep"],
]

export async function dumpAndDestroy(h: LxcHandle | null): Promise<void> {
  if (!h) return
  for (const [label, cmd] of DUMPS) {
    try {
      const r = await lxcExec(h, cmd, { allowFailure: true, timeoutMs: 15_000 })
      process.stderr.write(`\n--- ${label} (CTID ${h.ctid}) ---\n${r.stdout}\n`)
    } catch (e) {
      process.stderr.write(`\n--- ${label} dump failed: ${(e as Error).message} ---\n`)
    }
  }
  try {
    await destroyLxc(h)
  } catch (e) {
    process.stderr.write(`destroyLxc failed (CTID ${h.ctid}): ${(e as Error).message}\n`)
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun build --target=bun e2e/lxc/lib/diagnostics.ts --outdir=/tmp/typecheck 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add e2e/lxc/lib/diagnostics.ts
git commit -m "task(VOS-121): T9 lib/diagnostics.ts pre-destroy log capture"
```

---

## Task 10: `init-non-interactive.spec.ts` + `run.sh` + README

**Files:**
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/init-non-interactive.spec.ts`
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/run.sh`
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/e2e/lxc/README.md`

- [ ] **Step 1: Write the spec**

The daemon-check branch below assumes T0b RESOLVED that init auto-starts the daemon. If T0b resolved otherwise, swap the marked block.

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { resolve } from "node:path"
import { provisionLxc, lxcExec, waitForNet, type LxcHandle } from "./lib/lxc"
import { installBaseDeps, loginClaudev } from "./lib/setup"
import { rsyncIntoLxc } from "./lib/rsync"
import { dumpAndDestroy } from "./lib/diagnostics"

const REPO_ROOT = resolve(import.meta.dir, "../..")

let h: LxcHandle | null = null

beforeAll(async () => {
  const accessCode = process.env.CLAUDEV_ACCESS_CODE
  if (!accessCode) {
    throw new Error("CLAUDEV_ACCESS_CODE env required (mint via tools/mint-claudev-code.sh or admin.makscee.ru)")
  }

  h = await provisionLxc({})
  await waitForNet(h, 30_000)
  await installBaseDeps(h)
  await loginClaudev(h, accessCode)
  await rsyncIntoLxc(REPO_ROOT, h, "/root/void-os")
  await lxcExec(h, "cd /root/void-os && bun install && bun link", { timeoutMs: 120_000 })
}, 300_000)

afterAll(async () => { await dumpAndDestroy(h) })

describe("void-os init --non-interactive on fresh LXC", () => {
  it("seeds vault, daemon healthy, ask tinker writes test.md", async () => {
    const initR = await lxcExec(
      h!,
      "void-os init --non-interactive --vault /root/vault --skip-gh --skip-obsidian",
      { timeoutMs: 60_000 },
    )
    expect(initR.exitCode).toBe(0)
    expect(initR.stdout).toMatch(/vault:|seed/)

    // --- T0b RESOLVED BRANCH (assumes init auto-starts daemon) ---
    const dR = await lxcExec(h!, "void-os daemon status")
    expect(dR.exitCode).toBe(0)
    // --- (if T0b resolved init does NOT auto-start, replace above with) ---
    // const dR = await lxcExec(h!, "void-os daemon start")
    // expect(dR.exitCode).toBe(0)

    const askR = await lxcExec(
      h!,
      `void-os ask tinker "create a file called test.md with content hello"`,
      { timeoutMs: 180_000 },
    )
    expect(askR.exitCode).toBe(0)

    const cat = await lxcExec(h!, "cat /root/vault/test.md")
    expect(cat.exitCode).toBe(0)
    expect(cat.stdout).toContain("hello")
  }, 240_000)
})
```

- [ ] **Step 2: Write `run.sh`**

```sh
#!/bin/sh
set -eu
: "${CLAUDEV_ACCESS_CODE:?CLAUDEV_ACCESS_CODE required — mint via tools/mint-claudev-code.sh or admin.makscee.ru}"
: "${TOWER_HOST:=tower}"
export TOWER_HOST
cd "$(dirname "$0")/../.."
exec bun test e2e/lxc/init-non-interactive.spec.ts --timeout 300000
```

- [ ] **Step 3: Write `README.md`**

```markdown
# e2e/lxc — Fresh-LXC end-to-end test for VOS-121

Provisions a Proxmox LXC on `tower`, installs the void-os stack from a rsync'd
working tree, runs `void-os init --non-interactive` + `void-os ask tinker`,
asserts vault state, then destroys the LXC.

## Prerequisites

- SSH access to tower as root: `ssh root@tower true` must succeed silently.
- `bun` installed locally (host runs `bun test`).
- A one-shot claudev access code. Mint with:
  ```
  VOID_AUTH_ADMIN_TOKEN=<token> ./tools/mint-claudev-code.sh
  ```
  Or use the admin UI at admin.makscee.ru.

## Local run

```
CLAUDEV_ACCESS_CODE=XXXX-XXXX ./e2e/lxc/run.sh
```

Runs in ~3-4 minutes typical, 5 minute ceiling.

## Debugging

- `KEEP_LXC=1` — skip the post-test destroy; LXC stays on tower for inspection.
  `ssh root@tower` then `pct enter <ctid>` to debug.
- `TOWER_HOST=other-host.tailnet.ts.net` — point at a different Proxmox host.
- Per-test logs print to stderr in the dump phase before destroy.

## Known issues

- One-shot codes: each run consumes a fresh access code. Re-running needs a
  new mint. The `KEEP_LXC=1` flag is the workaround for tight debug loops.
- Concurrent local runs serialize via tower-side `flock /var/lock/vos-e2e-ctid`;
  the CI `concurrency.group: lxc-e2e` only serializes CI runs.
- claudev is pinned in `e2e/lxc/.claudev-version`. Bumps go through PR review.

## Files

- `init-non-interactive.spec.ts` — the test
- `lib/lxc.ts` — provision/exec/destroy with flock
- `lib/rsync.ts` — host→tower→LXC sync
- `lib/setup.ts` — apt + bun + pinned claudev install
- `lib/diagnostics.ts` — pre-destroy log dump
- `.claudev-version` — pinned claudev git ref
- `run.sh` — entry point
```

- [ ] **Step 4: Make scripts executable + commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
chmod +x e2e/lxc/run.sh
git add e2e/lxc/init-non-interactive.spec.ts e2e/lxc/run.sh e2e/lxc/README.md
git commit -m "task(VOS-121): T10 LXC E2E spec + run.sh + README"
```

---

## Task 11: `tools/mint-claudev-code.sh`

**Note:** The exact endpoint shape is finalized in T0a. Adjust the script body if T0a found a different path/field name.

**Files:**
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/tools/mint-claudev-code.sh`

- [ ] **Step 1: Write the script** (template assumes T0a confirmed `POST /v1/admin/access-codes` returns `{code}`)

```sh
#!/bin/sh
set -eu
: "${VOID_AUTH_URL:=https://auth.makscee.ru}"
: "${VOID_AUTH_ADMIN_TOKEN:?VOID_AUTH_ADMIN_TOKEN required}"

resp=$(curl -fsSL -X POST "$VOID_AUTH_URL/v1/admin/access-codes" \
  -H "authorization: Bearer $VOID_AUTH_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"purpose":"vos-e2e","ttl_seconds":600}')

# Prefer jq if available; fall back to python3.
if command -v jq >/dev/null 2>&1; then
  code=$(printf '%s' "$resp" | jq -r '.code')
else
  code=$(printf '%s' "$resp" | python3 -c 'import sys,json; print(json.load(sys.stdin)["code"])')
fi

if [ -z "$code" ] || [ "$code" = "null" ]; then
  printf 'mint-claudev-code: empty/missing code in response: %s\n' "$resp" >&2
  exit 1
fi

printf '%s\n' "$code"
```

- [ ] **Step 2: Smoke (against real void-auth)**

```bash
chmod +x /Users/admin/hub-wt/VOS-121/workspace/void-os/tools/mint-claudev-code.sh
# Set VOID_AUTH_ADMIN_TOKEN from your local secret store.
VOID_AUTH_ADMIN_TOKEN=$(sops -d /Users/admin/hub-wt/VOS-121/workspace/homelab/group_vars/all/secrets.sops.yml 2>/dev/null | grep void_auth_admin_token | awk '{print $2}' | tr -d '"') \
  /Users/admin/hub-wt/VOS-121/workspace/void-os/tools/mint-claudev-code.sh
```

Expected: prints a code matching `^[A-Z0-9]{4}-[A-Z0-9]{4}$` (or whatever T0a recorded). If it fails, fix the script per T0a findings.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add tools/mint-claudev-code.sh
git commit -m "task(VOS-121): T11 mint-claudev-code.sh"
```

---

## Task 12: Ansible role `gh-runner-vos` (homelab)

**Files (in `/Users/admin/hub-wt/VOS-121/workspace/homelab/`):**
- Create: `ansible/roles/gh-runner-vos/defaults/main.yml`
- Create: `ansible/roles/gh-runner-vos/tasks/main.yml`
- Create: `ansible/roles/gh-runner-vos/tasks/host-tower.yml`
- Create: `ansible/roles/gh-runner-vos/tasks/inside-lxc.yml`
- Create: `ansible/roles/gh-runner-vos/templates/runner.service.j2`
- Create: `ansible/roles/gh-runner-vos/templates/sudoers-vos-runner.j2`
- Create: `ansible/roles/gh-runner-vos/vars/main.sops.yml` (SOPS-encrypted)
- Create: `ansible/playbooks/gh-runner-vos.yml`
- Create: `ansible/roles/gh-runner-vos/README.md`
- Modify: `ansible/inventory/homelab.yml` — add `gh-runner-vos` entry (CTID 198)

- [ ] **Step 1: `defaults/main.yml`**

```yaml
---
ghr_ctid: 198
ghr_hostname: gh-runner-vos
ghr_storage: local-lvm
ghr_memory: 4096
ghr_cores: 2
ghr_rootfs_gb: 20
ghr_template: debian-12-standard
ghr_runner_version: "2.317.0"
ghr_runner_arch: x64
ghr_github_repo: "makscee/void-os"
ghr_runner_labels: "lxc-tower"
ghr_runner_workdir: /home/runner/actions-runner
ghr_runner_user: runner
ghr_tower_runner_user: runner
```

- [ ] **Step 2: `templates/sudoers-vos-runner.j2`**

```
# Managed by Ansible — VOS-121 gh-runner-vos role
{{ ghr_tower_runner_user }} ALL=(ALL) NOPASSWD: /usr/local/sbin/vos-pct
Defaults!/usr/local/sbin/vos-pct !requiretty
```

- [ ] **Step 3: `templates/runner.service.j2`**

```
[Unit]
Description=GitHub Actions Runner (void-os)
After=network.target

[Service]
Type=simple
User={{ ghr_runner_user }}
WorkingDirectory={{ ghr_runner_workdir }}
ExecStart={{ ghr_runner_workdir }}/run.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: `tasks/host-tower.yml`** (runs on the Proxmox host)

```yaml
---
- name: Ensure runner user exists on tower
  ansible.builtin.user:
    name: "{{ ghr_tower_runner_user }}"
    shell: /bin/bash
    create_home: yes

- name: Install vos-pct wrapper
  ansible.builtin.copy:
    src: vos-pct
    dest: /usr/local/sbin/vos-pct
    mode: '0755'
    owner: root
    group: root

- name: Install sudoers for vos-pct
  ansible.builtin.template:
    src: sudoers-vos-runner.j2
    dest: /etc/sudoers.d/vos-runner
    mode: '0440'
    owner: root
    group: root
    validate: 'visudo -cf %s'

- name: Create LXC for runner (CTID {{ ghr_ctid }})
  ansible.builtin.command:
    cmd: >
      pct create {{ ghr_ctid }}
        local:vztmpl/{{ ghr_template }}.tar.zst
        --hostname {{ ghr_hostname }}
        --memory {{ ghr_memory }} --cores {{ ghr_cores }}
        --rootfs {{ ghr_storage }}:{{ ghr_rootfs_gb }}
        --features nesting=1 --unprivileged 1
        --net0 name=eth0,bridge=vmbr0,ip=dhcp
        --start 1
    creates: /etc/pve/lxc/{{ ghr_ctid }}.conf

- name: Wait for LXC network
  ansible.builtin.command:
    cmd: pct exec {{ ghr_ctid }} -- getent hosts github.com
  register: net_check
  retries: 20
  delay: 3
  until: net_check.rc == 0
  changed_when: false

- name: Authorize tower runner-user ssh key into the LXC root (for vos-pct calls)
  ansible.builtin.shell: |
    test -f /root/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N '' -f /home/{{ ghr_tower_runner_user }}/.ssh/id_ed25519
    pct exec {{ ghr_ctid }} -- mkdir -p /root/.ssh
    pct push {{ ghr_ctid }} /home/{{ ghr_tower_runner_user }}/.ssh/id_ed25519.pub /root/.ssh/authorized_keys
    chown -R {{ ghr_tower_runner_user }}:{{ ghr_tower_runner_user }} /home/{{ ghr_tower_runner_user }}/.ssh
  args: { creates: /home/{{ ghr_tower_runner_user }}/.ssh/id_ed25519.pub }
```

- [ ] **Step 5: `tasks/inside-lxc.yml`** (delegated to the new LXC via `lxc-attach`/`pct exec`; idiomatic Ansible would use the `community.general.proxmox` connection plugin)

```yaml
---
- name: Install runner LXC packages
  ansible.builtin.shell: |
    pct exec {{ ghr_ctid }} -- bash -lc '
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y curl git jq tar gzip ca-certificates sudo unzip
    '
  changed_when: false

- name: Install bun in LXC
  ansible.builtin.shell: |
    pct exec {{ ghr_ctid }} -- bash -lc '
      command -v bun >/dev/null && exit 0
      curl -fsSL https://bun.sh/install | bash
      ln -sf /root/.bun/bin/bun /usr/local/bin/bun
    '
  changed_when: false

- name: Install Tailscale + join (ephemeral)
  ansible.builtin.shell: |
    pct exec {{ ghr_ctid }} -- bash -lc '
      command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
      tailscale up --authkey={{ ts_authkey }} --hostname={{ ghr_hostname }} --ephemeral || true
    '
  no_log: true

- name: Create runner user inside LXC
  ansible.builtin.shell: |
    pct exec {{ ghr_ctid }} -- bash -lc '
      id -u {{ ghr_runner_user }} >/dev/null 2>&1 || useradd -m -s /bin/bash {{ ghr_runner_user }}
    '
  changed_when: false

- name: Download and unpack GH Actions runner
  ansible.builtin.shell: |
    pct exec {{ ghr_ctid }} -- bash -lc '
      mkdir -p {{ ghr_runner_workdir }} && cd {{ ghr_runner_workdir }}
      if [ ! -f config.sh ]; then
        curl -fsSL -o actions-runner.tar.gz \
          https://github.com/actions/runner/releases/download/v{{ ghr_runner_version }}/actions-runner-linux-{{ ghr_runner_arch }}-{{ ghr_runner_version }}.tar.gz
        tar xzf actions-runner.tar.gz
        rm actions-runner.tar.gz
        chown -R {{ ghr_runner_user }}:{{ ghr_runner_user }} {{ ghr_runner_workdir }}
      fi
    '
  args: { creates: "/var/lib/lxc/{{ ghr_ctid }}/rootfs{{ ghr_runner_workdir }}/config.sh" }

- name: Configure GH Actions runner (idempotent)
  ansible.builtin.shell: |
    pct exec {{ ghr_ctid }} -- bash -lc '
      cd {{ ghr_runner_workdir }}
      if [ ! -f .runner ]; then
        sudo -u {{ ghr_runner_user }} ./config.sh \
          --url https://github.com/{{ ghr_github_repo }} \
          --token {{ github_runner_token }} \
          --labels {{ ghr_runner_labels }} \
          --name {{ ghr_hostname }} \
          --unattended \
          --replace
      fi
    '
  no_log: true

- name: Install + start runner systemd unit
  ansible.builtin.shell: |
    pct exec {{ ghr_ctid }} -- bash -lc '
      cat > /etc/systemd/system/actions.runner.service <<UNIT
[Unit]
Description=GitHub Actions Runner (void-os)
After=network.target

[Service]
Type=simple
User={{ ghr_runner_user }}
WorkingDirectory={{ ghr_runner_workdir }}
ExecStart={{ ghr_runner_workdir }}/run.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload
      systemctl enable --now actions.runner.service
    '
  changed_when: false
```

- [ ] **Step 6: `tasks/main.yml`**

```yaml
---
- name: Decrypt SOPS vars
  community.sops.load_vars:
    file: "{{ role_path }}/vars/main.sops.yml"
  no_log: true

- include_tasks: host-tower.yml
- include_tasks: inside-lxc.yml
```

- [ ] **Step 7: `vars/main.sops.yml`** (encrypted with operator's SOPS key)

Plaintext shape (before SOPS encrypts):

```yaml
github_runner_token: "ghs_REPLACE_ME"
ts_authkey: "tskey-auth-REPLACE_ME"
void_auth_admin_token: "REPLACE_ME"
```

Encrypt:

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/homelab
# Edit ansible/roles/gh-runner-vos/vars/main.sops.yml first with the real values.
sops --encrypt --in-place ansible/roles/gh-runner-vos/vars/main.sops.yml
```

(Per `feedback_ansible_sops_decrypt` memory: must use `community.sops.load_vars` — not `vars_files`. Already done in tasks/main.yml.)

- [ ] **Step 8: `ansible/playbooks/gh-runner-vos.yml`**

```yaml
---
- hosts: tower
  become: yes
  roles:
    - gh-runner-vos
```

- [ ] **Step 9: Update inventory**

In `ansible/inventory/homelab.yml`, ensure `tower` group exists (it does per existing memory) — no new host needed; the role creates the LXC inside.

Optionally add a documentation entry:

```yaml
# CTID 198 — gh-runner-vos (managed by roles/gh-runner-vos)
```

- [ ] **Step 10: Role `README.md`**

```markdown
# gh-runner-vos — Self-hosted GH Actions runner for void-os LXC E2E

Provisions an unprivileged Debian 12 LXC (CTID 198) on tower, joins it to
Tailscale, registers it as a GitHub Actions runner against
`makscee/void-os` with label `lxc-tower`. Also installs `vos-pct`
wrapper + sudoers on the tower host (least-privilege `pct` access for
the runner).

## Run

```
cd ansible
ansible-playbook -i inventory/homelab.yml playbooks/gh-runner-vos.yml
```

## Secrets (vars/main.sops.yml)

- `github_runner_token` — short-lived registration token from
  https://github.com/makscee/void-os/settings/actions/runners/new
- `ts_authkey` — Tailscale ephemeral authkey
- `void_auth_admin_token` — passed to runner env for `tools/mint-claudev-code.sh`

## Re-registration

If GitHub revokes the runner or you bump `ghr_runner_version`:

1. Mint a fresh registration token in GitHub UI.
2. Update `vars/main.sops.yml` (`sops` to edit in place).
3. Remove `.runner` inside the LXC: `ssh root@tower 'pct exec 198 -- rm /home/runner/actions-runner/.runner'`
4. Re-run the playbook.

## Rollback

```
ssh root@tower 'pct stop 198 && pct destroy 198 --purge'
ssh root@tower 'rm /etc/sudoers.d/vos-runner /usr/local/sbin/vos-pct'
```
```

- [ ] **Step 11: Smoke check (syntax only, no apply)**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/homelab/ansible
ansible-playbook --syntax-check playbooks/gh-runner-vos.yml 2>&1 | tail -15
```

Expected: no syntax errors. Real apply is in T14.

- [ ] **Step 12: Commit (homelab repo, direct to main)**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/homelab
git add ansible/roles/gh-runner-vos/ ansible/playbooks/gh-runner-vos.yml ansible/inventory/homelab.yml
git commit -m "feat(gh-runner-vos): provisions VOS-121 self-hosted runner on tower"
```

---

## Task 13: GitHub Actions workflow

**Files:**
- Create: `/Users/admin/hub-wt/VOS-121/workspace/void-os/.github/workflows/lxc-e2e.yml`

- [ ] **Step 1: Write workflow**

```yaml
name: lxc-e2e
on:
  workflow_dispatch:
  pull_request:
    paths:
      - 'cli/init.ts'
      - 'cli/init/**'
      - 'cli/ask.ts'
      - 'cli/daemon.ts'
      - 'e2e/lxc/**'
      - 'tools/mint-claudev-code.sh'
      - '.github/workflows/lxc-e2e.yml'

concurrency:
  group: lxc-e2e
  cancel-in-progress: false   # queue, don't preempt

jobs:
  lxc-e2e:
    runs-on: [self-hosted, lxc-tower]
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - name: Ensure bun on PATH
        run: |
          if ! command -v bun >/dev/null; then
            curl -fsSL https://bun.sh/install | bash
          fi
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"

      - name: bun install
        run: bun install

      - name: Mint claudev access code
        env:
          VOID_AUTH_ADMIN_TOKEN: ${{ secrets.VOID_AUTH_ADMIN_TOKEN }}
        run: |
          CODE=$(./tools/mint-claudev-code.sh)
          echo "::add-mask::$CODE"
          echo "CLAUDEV_ACCESS_CODE=$CODE" >> "$GITHUB_ENV"

      - name: LXC E2E
        env:
          TOWER_HOST: tower
        run: ./e2e/lxc/run.sh
```

- [ ] **Step 2: Commit**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
git add .github/workflows/lxc-e2e.yml
git commit -m "task(VOS-121): T13 CI workflow for LXC E2E on self-hosted runner"
```

- [ ] **Step 3: Add GitHub secret**

In a browser (or `gh secret set` from operator host):

```bash
echo -n '<void_auth_admin_token_value>' | gh secret set VOID_AUTH_ADMIN_TOKEN -R makscee/void-os
```

Expected: `gh secret list -R makscee/void-os` shows `VOID_AUTH_ADMIN_TOKEN`.

---

## Task 14: Bring up the runner and shake down the workflow

**Files:** none new — this is operational bring-up.

- [ ] **Step 1: Apply the Ansible role**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/homelab/ansible
ansible-playbook -i inventory/homelab.yml playbooks/gh-runner-vos.yml -v 2>&1 | tail -40
```

Expected: role completes; runner LXC up on tower; GH UI shows the runner as `Idle` under `makscee/void-os` Settings → Actions → Runners.

- [ ] **Step 2: Verify vos-pct wrapper on tower**

```bash
ssh root@tower /usr/local/sbin/vos-pct list | head
ssh runner@tower 'sudo /usr/local/sbin/vos-pct destroy 100' 2>&1 | head
```

Expected:
- First command lists CTIDs (works as root).
- Second command rejects with `vos-pct: rejected: CTID 100 not in allowlist`.

- [ ] **Step 3: Local dry-run of the E2E**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
CLAUDEV_ACCESS_CODE=$(VOID_AUTH_ADMIN_TOKEN=$(gh secret list -R makscee/void-os --json name | grep -c VOID_AUTH_ADMIN_TOKEN >/dev/null && echo "$VOID_AUTH_ADMIN_TOKEN_LOCAL") ./tools/mint-claudev-code.sh) ./e2e/lxc/run.sh 2>&1 | tail -40
```

(Replace the `VOID_AUTH_ADMIN_TOKEN_LOCAL` with the operator's local copy from SOPS or 1Password — the secret store entry already used by other tools.)

Expected: full run passes within 5 minutes. If it fails, the dump phase prints daemon log + vault tree + journalctl to stderr — diagnose from those.

- [ ] **Step 4: Trigger workflow via `workflow_dispatch`**

```bash
gh workflow run lxc-e2e -R makscee/void-os
sleep 10
gh run watch -R makscee/void-os
```

Expected: green run within ~5 min. Capture the run URL.

- [ ] **Step 5: Log success in task Work Log**

```bash
tools/state-write/sw "task(VOS-121): T14 first green LXC E2E run" -- bash -c '
  set -e
  cd /Users/admin/hub
  f=$(ls vault/work/tasks/active/VOS-121-*.md | head -1)
  cat >> "$f" <<EOF

### $(date -u +%Y-%m-%d) · first green LXC E2E
- workflow run: <paste URL>
- local run: passed in <Ns>
EOF
  git add "$f"
'
```

---

## Task 15: Final regression + review

**Files:** none new.

- [ ] **Step 1: Full void-os test suite**

```bash
cd /Users/admin/hub-wt/VOS-121/workspace/void-os
bun test 2>&1 | tail -25
```

Expected: all green, including new init unit + e2e tests. LXC E2E is not in this run (it's invoked via `e2e/lxc/run.sh`).

- [ ] **Step 2: Confirm acceptance checklist (from spec)**

Walk the spec's `## Deliverables checklist`. Tick each:

- [ ] `cli/init.ts` + `cli/init/configure.ts` non-interactive path (T1-T4)
- [ ] `e2e/lxc/lib/{lxc,rsync,setup,diagnostics}.ts` (T6-T9)
- [ ] `e2e/lxc/init-non-interactive.spec.ts` (T10)
- [ ] `e2e/lxc/run.sh` (T10)
- [ ] `e2e/lxc/README.md` (T10)
- [ ] `tools/mint-claudev-code.sh` (T11)
- [ ] `e2e/lxc/.claudev-version` (T8)
- [ ] `.github/workflows/lxc-e2e.yml` (T13)
- [ ] `workspace/homelab/ansible/roles/gh-runner-vos/` (T5, T12)
- [ ] `workspace/homelab/ansible/playbooks/gh-runner-vos.yml` (T12)
- [ ] Runner registered against `makscee/void-os`, label `lxc-tower`, online (T14)
- [ ] One green LXC E2E run logged in task Work Log (T14)

- [ ] **Step 3: Code review (mandatory per hub gate)**

Dispatch `superpowers:requesting-code-review` over the full task branch. Address feedback; commit fixes; re-review until clean.

- [ ] **Step 4: Ready for /done**

Prompt user: "All acceptance met. Run `/done VOS-121`?"
