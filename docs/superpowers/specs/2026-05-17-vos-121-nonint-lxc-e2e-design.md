---
task: VOS-121
title: --non-interactive init + automated LXC E2E
created: 2026-05-17
status: spec
---

# VOS-121 — `--non-interactive` init + automated LXC E2E

## Goal

Make `void-os init` driveable headlessly via CLI flags (no prompts), and add an automated end-to-end test that provisions a fresh Proxmox LXC on `tower`, installs the stack from scratch, asks Tinker to write a file, and asserts vault state. The test is runnable locally (`./e2e/lxc/run.sh`) and from CI (self-hosted GitHub Actions runner inside the tailnet).

## Scope

In-scope:

1. New CLI flags on `void-os init`: `--non-interactive`, `--vault`, `--gh-repo`, `--skip-gh`, `--skip-obsidian`, `--obsidian-vault`.
2. A `decideFromFlags()` path that bypasses `configure()` interactive prompts.
3. `workspace/void-os/e2e/lxc/` directory: helpers, one spec, `run.sh`, README.
4. `workspace/void-os/tools/mint-claudev-code.sh` — operator/CI helper that mints a one-shot claudev access code via void-auth admin API.
5. `workspace/void-os/.github/workflows/lxc-e2e.yml` — workflow targeting `[self-hosted, lxc-tower]`.
6. `workspace/homelab/ansible/roles/gh-runner-vos/` — Ansible role that provisions the self-hosted runner LXC on tower, including a dedicated unprivileged `runner` user on tower with `sudo pct *` perms, ssh keypair, and Tailscale join.

Out-of-scope:

- `--skip-plugin` flag. `installPlugin()` already auto-skips when `plugin/dist` is absent; LXC test never builds the plugin, so the auto-skip path is exercised.
- Mac manual smoke checklist (covered by VOS-122).
- Fresh-user README rewrite (covered by VOS-122).
- Operator tooling for repeatable manual passes (covered by VOS-123).
- Long-lived "machine" claudev tokens. Each test run mints a fresh one-shot code.

## Acceptance criteria (from task file)

- [ ] `void-os init --non-interactive` accepts: `--vault <path>`, `--gh-repo <name>` (or `--skip-gh`), `--skip-obsidian`.
- [ ] No prompts in `--non-interactive` mode; missing `--vault` causes clear error + non-zero exit (code 64).
- [ ] Automated E2E script in `e2e/lxc/`: provisions fresh Debian 12 LXC on tower, installs bun + claudev (which provides `claude`) + git, rsyncs the local working tree, runs `bun install && bun link`, runs `void-os init --non-interactive --vault /root/vault`, then `void-os ask tinker "create a file called test.md with content hello"`, asserts `/root/vault/test.md` exists and contains `hello`.
- [ ] Test exits clean on success, prints failure cause on error; runnable locally (`./e2e/lxc/run.sh`) and from CI (workflow runs on self-hosted runner).
- [ ] README documents how to run LXC E2E locally for debugging (including how to mint a claudev access code).
- [ ] Test runtime under 5 minutes (LXC provision + install + smoke).

## Component 1 — `--non-interactive` flag wiring

### Files changed

- `workspace/void-os/cli/init.ts` — flag parser + orchestration branch.
- `workspace/void-os/cli/init/configure.ts` — extract `decideFromFlags()` alongside existing `configure()`.
- `workspace/void-os/cli/init.test.ts` (existing) — add unit tests for `decideFromFlags()` and flag validation.

### Flag contract

```
--non-interactive            # master switch; required for the others to have non-prompt effect
--vault <path>               # required iff --non-interactive
--gh-repo <name>             # opts INTO gh push; mutually exclusive with --skip-gh
--skip-gh                    # explicit opt-out (default behavior); for log clarity
--skip-obsidian              # explicit opt-out of obsidian vault name registration
--obsidian-vault <name>      # sets obsidian vault display name; default "void" when obsidian detected
```

`parseFlags()` extensions:

- `nonInteractive: boolean` — true if `--non-interactive` present.
- `vault?: string`, `ghRepo?: string`, `skipGh: boolean`, `skipObsidian: boolean`, `obsidianVault?: string`.

### Validation (fatal errors, before any IO)

| Condition | Exit code | Message |
|---|---|---|
| `--non-interactive` without `--vault <path>` | 64 | `--non-interactive requires --vault <path>` |
| `--gh-repo` and `--skip-gh` both set | 64 | `--gh-repo and --skip-gh are mutually exclusive` |
| `--non-interactive` and `--gh-repo X` but `report.gh.found/authed` false | 65 | `gh not available (not installed or not authed); remove --gh-repo or fix gh first` |

### `decideFromFlags(report, flags) → Decisions`

Returns the same `Decisions` shape `configure()` returns:

```ts
{
  vaultPath: expandHome(flags.vault!),
  gh: flags.ghRepo ? { push: true, repoName: flags.ghRepo } : { push: false },
  obsidianVaultName: flags.skipObsidian
    ? undefined
    : (flags.obsidianVault ?? (report.obsidian.found ? "void" : undefined)),
  cancelled: false,
}
```

### Orchestrator branch in `initCommand()`

```ts
const decisions = flags.nonInteractive
  ? decideFromFlags(report, flags)
  : await configure(report, prompter)
```

### Preflight behavior under `--non-interactive`

- `enforce(report, { offerBrewInstallBun })` currently prompts when bun is missing on darwin. In `--non-interactive` mode, pass `offerBrewInstallBun: () => false` so the missing-bun path becomes a hard `PreflightError` instead of an interactive prompt. Existing `PreflightError` exit-code path is preserved.

### `installPlugin` under `--non-interactive`

Unchanged. `installPlugin()` already returns clean when `plugin/dist` is absent. LXC test never builds the plugin, so this branch is exercised. No new flag.

### Unit tests added

In `cli/init/configure.test.ts` (new section) or `cli/init.test.ts`:

1. `decideFromFlags`: vault expansion (`~` and absolute).
2. `decideFromFlags`: `--gh-repo X` → `{ push: true, repoName: "X" }`.
3. `decideFromFlags`: neither `--gh-repo` nor `--skip-gh` → `{ push: false }`.
4. `decideFromFlags`: `--skip-obsidian` overrides obsidian default name.
5. `parseFlags`: `--non-interactive` without `--vault` → throws/exits 64 with message.
6. `parseFlags`: `--gh-repo X --skip-gh` → exits 64.
7. `initCommand`: with `--non-interactive` + flags + injected fake `preflight`, runs end-to-end against a temp `prefix` using existing `ScriptedPrompter` left empty (no prompts should fire — empty queue with zero pops proves it). This is a unit-level reuse of the existing `init.e2e.test.ts` harness, not the LXC test.

## Component 2 — LXC E2E test

### Directory layout

```
workspace/void-os/e2e/lxc/
  lib/
    lxc.ts            # provisionLxc, lxcExec, destroyLxc, waitForNet
    rsync.ts          # rsyncIntoLxc
    setup.ts          # installBaseDeps, loginClaudev
    diagnostics.ts    # dumpAndDestroy (collect logs → stderr → destroy)
  init-non-interactive.spec.ts
  run.sh
  README.md
```

### Container runtime decisions

| Concern | Decision |
|---|---|
| Container | Proxmox LXC on tower (real, not Docker) |
| Template | `debian-12-standard` (already present on tower) |
| CTID range | `9100-9199` reserved for VOS E2E; first free chosen via `pct list` parse |
| Hostname | `vos-e2e-<6char-random>` |
| Network | DHCP on vmbr0; **no tailnet required** (auth via public `auth.makscee.ru`) |
| Features | `nesting=1` (claudev/bun may want it); unprivileged container |
| Resources | 2 vCPU, 1G RAM, 8G disk |
| Lifecycle | Destroy always (success or fail) via `afterAll` + signal trap in `run.sh` |

### `lib/lxc.ts` API

```ts
export interface LxcHandle { ctid: number; hostname: string }

export async function provisionLxc(opts: {
  template?: string         // default "debian-12-standard"
  ctidRange?: [number, number]  // default [9100, 9199]
  towerHost?: string        // default process.env.TOWER_HOST ?? "tower"
}): Promise<LxcHandle>

export async function lxcExec(
  h: LxcHandle,
  cmd: string,
  opts?: { timeoutMs?: number; allowFailure?: boolean; env?: Record<string,string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }>

export async function waitForNet(h: LxcHandle, timeoutMs?: number): Promise<void>

export async function destroyLxc(h: LxcHandle): Promise<void>
```

Implementation notes:

- All ops shell out to `ssh root@<towerHost>` and run `pct` there.
- `lxcExec` uses `pct exec <ctid> -- bash -lc '<cmd>'`; `cmd` is base64-encoded into a heredoc-free single argv to avoid quoting hell. Stdout/stderr captured separately via `2>&1` redirection in a wrapper script.
- `provisionLxc` picks first free CTID: `pct list | awk 'NR>1 {print $1}'` → intersect with reserved range → first free. Race-safe enough because tower is single-operator; in CI the runner is a single instance.
- Env passing: `pct exec --env KEY=VAL` is NOT supported on older pct; we instead `printf 'export X=Y\n' | pct push` then source. Spec assumes only `CLAUDEV_ACCESS_CODE` needs in-container env, handled via stdin pipe to `claudev login` directly (no env needed).

### `lib/rsync.ts` API

```ts
export async function rsyncIntoLxc(
  localPath: string, h: LxcHandle, destPath: string,
  excludes?: string[]  // default ["node_modules", ".git", "dist"]
): Promise<void>
```

Implementation: rsync from operator host → tower (`ssh root@tower`) into a staging dir, then `pct push` the staging tarball into the container, then untar. The `pct push` of a tarball avoids per-file `pct push` calls which are slow.

### `lib/setup.ts` API

```ts
export async function installBaseDeps(h: LxcHandle): Promise<void>
// apt-get update + apt-get install -y curl git unzip ca-certificates
// curl -fsSL https://bun.sh/install | bash; export PATH ~/.bun/bin
// curl -fsSL https://auth.makscee.ru/claudev/install.sh | sh

export async function loginClaudev(h: LxcHandle, accessCode: string): Promise<void>
// echo "$accessCode" | claudev login
// Assert /root/.claudev/token exists and starts with "sk-ant-"
```

### `lib/diagnostics.ts` API

```ts
export async function dumpAndDestroy(h: LxcHandle | null): Promise<void>
// If h is null: no-op (provisioning failed before handle).
// Otherwise: collect to stderr:
//   - pct status <ctid>
//   - pct exec <ctid> -- cat ~/.void-os/daemon.log
//   - pct exec <ctid> -- find /root/vault -type f | head -50
//   - pct exec <ctid> -- journalctl -xe --no-pager | tail -100
// Then destroyLxc(h). Errors during collection swallowed (we're already in failure path).
```

### `init-non-interactive.spec.ts`

Uses `bun:test` (not Playwright — no browser needed). Single describe block:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { provisionLxc, lxcExec, waitForNet, type LxcHandle } from "./lib/lxc"
import { installBaseDeps, loginClaudev } from "./lib/setup"
import { rsyncIntoLxc } from "./lib/rsync"
import { dumpAndDestroy } from "./lib/diagnostics"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../..")

let h: LxcHandle | null = null

beforeAll(async () => {
  const accessCode = process.env.CLAUDEV_ACCESS_CODE
  if (!accessCode) throw new Error("CLAUDEV_ACCESS_CODE env required (mint at admin.makscee.ru)")

  h = await provisionLxc({})
  await waitForNet(h, 30_000)
  await installBaseDeps(h)
  await loginClaudev(h, accessCode)
  await rsyncIntoLxc(REPO_ROOT, h, "/root/void-os")
  await lxcExec(h, "cd /root/void-os && bun install && bun link")
}, 240_000)

afterAll(async () => { await dumpAndDestroy(h) })

describe("void-os init --non-interactive on fresh LXC", () => {
  it("seeds vault, starts daemon, ask tinker writes test.md", async () => {
    const initR = await lxcExec(h!, "void-os init --non-interactive --vault /root/vault")
    expect(initR.exitCode).toBe(0)
    expect(initR.stdout).toMatch(/seed: void-os init|vault:/)  // formatReport content

    // Start daemon if init didn't (verified in T2 of impl plan):
    const dR = await lxcExec(h!, "void-os daemon start", { allowFailure: true })
    if (dR.exitCode !== 0) {
      // If daemon is already running (auto-started by init), tolerate.
      expect(dR.stderr).toMatch(/already running|listening/)
    }

    const askR = await lxcExec(
      h!,
      `void-os ask tinker "create a file called test.md with content hello"`,
      { timeoutMs: 60_000 },
    )
    expect(askR.exitCode).toBe(0)

    const filer = await lxcExec(h!, "cat /root/vault/test.md")
    expect(filer.exitCode).toBe(0)
    expect(filer.stdout).toContain("hello")
  }, 120_000)
})
```

### `run.sh`

```sh
#!/bin/sh
set -eu
: "${CLAUDEV_ACCESS_CODE:?CLAUDEV_ACCESS_CODE required — mint at admin.makscee.ru/access-codes}"
: "${TOWER_HOST:=tower}"
export TOWER_HOST
cd "$(dirname "$0")/../.."
exec bun test e2e/lxc/init-non-interactive.spec.ts --timeout 300000
```

### `e2e/lxc/README.md` (sections)

- Prerequisites: SSH key on tower (`ssh root@tower true` must succeed), bun installed locally, claudev access code.
- How to mint a code: link to admin.makscee.ru flow + the `tools/mint-claudev-code.sh` helper.
- Local run: `CLAUDEV_ACCESS_CODE=XXXX-XXXX ./e2e/lxc/run.sh`.
- Debugging: how to disable destroy (e.g. `KEEP_LXC=1 ./e2e/lxc/run.sh` — implement as flag honored by `dumpAndDestroy`).
- Known issue: one-shot codes mean re-running consumes a new code each time.

### Timeout budget (under 5min acceptance)

| Phase | Estimate |
|---|---|
| provisionLxc + waitForNet | 30s |
| installBaseDeps (apt + bun + claudev) | 60s |
| loginClaudev | 3s |
| rsyncIntoLxc | 10s |
| bun install + bun link | 40s |
| init --non-interactive | 10s |
| daemon start (if needed) | 3s |
| ask tinker (real LLM round-trip) | 30-60s |
| cat assertion | 1s |
| dumpAndDestroy | 10s |
| **Total** | **~200s, within 5-min cap** |

## Component 3 — `tools/mint-claudev-code.sh`

POSIX shell, executable. Inputs from env:

```sh
#!/bin/sh
set -eu
: "${VOID_AUTH_URL:=https://auth.makscee.ru}"
: "${VOID_AUTH_ADMIN_TOKEN:?required}"
resp=$(curl -fsSL -X POST "$VOID_AUTH_URL/v1/admin/access-codes" \
  -H "authorization: Bearer $VOID_AUTH_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"purpose":"vos-e2e","ttl_seconds":600}')
code=$(printf '%s' "$resp" | python3 -c 'import sys,json; print(json.load(sys.stdin)["code"])')
printf '%s\n' "$code"
```

**Spec note:** the exact admin endpoint shape (`POST /v1/admin/access-codes`, response field `code`) must be verified against the current void-auth API during implementation. The impl plan's T0 includes a void-auth API probe and the script is finalized after that probe.

## Component 4 — Self-hosted runner provisioning (Ansible)

### Files

```
workspace/homelab/ansible/
  roles/gh-runner-vos/
    tasks/main.yml             # create LXC, install runner, register, enable service
    templates/runner.service.j2
    defaults/main.yml
    vars/main.sops.yml         # SOPS-encrypted: github_runner_token, ts_authkey, void_auth_admin_token
  playbooks/gh-runner-vos.yml  # plays the role on tower (Proxmox host)
  inventory/homelab.yml        # add gh-runner-vos LXC (CTID 198, hostname gh-runner-vos)
```

### Role behavior

1. On tower (delegate_to): `pct create 198 debian-12 ... --hostname gh-runner-vos --features nesting=1 --unprivileged 1 --memory 4096 --rootfs local-lvm:20`.
2. Inside the LXC (via `community.general.proxmox` or `pct exec` shell tasks):
   - Install curl, jq, tailscale, git, bun.
   - Tailscale up with ephemeral authkey from SOPS vault.
   - Create `runner` user (unprivileged in LXC, no sudo inside LXC).
   - Download GH Actions runner tarball, unpack to `/home/runner/actions-runner`.
   - Configure runner: `./config.sh --url https://github.com/makscee/void-os --token <secret> --labels lxc-tower --unattended`.
   - Install systemd unit, enable + start.
3. On tower (host): create unprivileged `runner` user, add ssh authorized_keys entry from the LXC's generated keypair, add sudoers line `runner ALL=(ALL) NOPASSWD: /usr/sbin/pct *`.
4. Document the bootstrap: `workspace/homelab/ansible/roles/gh-runner-vos/README.md` with one-line invocation, secret rotation, runner re-registration.

### Why this is in scope

User chose "Workflow + runner provisioning in this task" in brainstorming. The workflow is useless without a runner answering its label.

### Why a dedicated `runner` user on tower (not root)

`pct` requires elevated perms; running the GH workflow as root on the Proxmox host is excessive. A dedicated user with sudoers scoped to `pct *` is least-privilege.

## Component 5 — CI workflow

`workspace/void-os/.github/workflows/lxc-e2e.yml`:

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
      - '.github/workflows/lxc-e2e.yml'
concurrency:
  group: lxc-e2e
  cancel-in-progress: false   # don't preempt a running LXC; queue instead
jobs:
  lxc-e2e:
    runs-on: [self-hosted, lxc-tower]
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - name: Install bun
        run: curl -fsSL https://bun.sh/install | bash
      - name: bun install
        run: ~/.bun/bin/bun install
      - name: Mint claudev access code
        env:
          VOID_AUTH_ADMIN_TOKEN: ${{ secrets.VOID_AUTH_ADMIN_TOKEN }}
        run: |
          CODE=$(./tools/mint-claudev-code.sh)
          echo "::add-mask::$CODE"
          echo "CLAUDEV_ACCESS_CODE=$CODE" >> $GITHUB_ENV
      - name: LXC E2E
        env:
          TOWER_HOST: tower
        run: ~/.bun/bin/bun test e2e/lxc/init-non-interactive.spec.ts --timeout 300000
```

GitHub secrets required on the void-os repo: `VOID_AUTH_ADMIN_TOKEN`.

`concurrency` prevents two PRs from racing on the same CTID range; serial queue is fine because runtime is <5min.

## Risks and open questions

1. **void-auth admin API for minting codes** is not verified. If the endpoint doesn't exist or has a different shape, `tools/mint-claudev-code.sh` and the workflow's mint step are wrong. **Mitigation:** impl plan T0 is a void-auth API probe; script + workflow finalized post-probe. If the API is missing, scope a `VAU-N` task to add it before VOS-121 ships.
2. **`daemon start` after init.** Whether `void-os init` auto-starts the daemon or requires a separate `daemon start` command is unclear from current code. Spec allows either; impl plan T2 verifies and removes the redundant call if init auto-starts.
3. **One-shot access codes** mean every run consumes a code. For local debug loops this is friction. Mitigation: README + offer a `KEEP_LXC=1` mode so debug runs reuse one LXC + one login until manually destroyed.
4. **`pct push` performance** of a tarball'd 100MB+ working tree may surprise. If rsync-into-LXC exceeds 30s, switch to mounting the host rsync target into the LXC via bind mount during provision.
5. **Runner provisioning is a homelab change** with operational impact (SOPS secret rotation, new ssh user on tower, sudoers entry). User approved scope inclusion; we ship it but commit homelab changes separately from void-os changes for clean rollback.
6. **No claudev-released binary path used in test.** `auth.makscee.ru/claudev/install.sh` fetches the current pinned release. If a broken release is published, the LXC test breaks even though void-os code is fine. Acceptable for now; revisit if it bites.

## Non-goals (explicit)

- Testing claudev itself. claudev has its own test suite.
- Testing void-keys / void-auth APIs. Those have their own tests.
- Testing the Obsidian plugin path. LXC has no display; plugin skipped via auto-skip.
- Multi-LXC parallel test runs.
- Cross-distro coverage (Ubuntu, Alpine). Debian 12 only.

## Implementation order (for impl plan)

Roughly: probe → flag wiring → helpers → spec → CI workflow → runner provisioning. Detailed in the implementation plan.

## Deliverables checklist

- [ ] `cli/init.ts` + `cli/init/configure.ts` non-interactive path (with unit tests)
- [ ] `e2e/lxc/lib/{lxc,rsync,setup,diagnostics}.ts`
- [ ] `e2e/lxc/init-non-interactive.spec.ts`
- [ ] `e2e/lxc/run.sh`
- [ ] `e2e/lxc/README.md`
- [ ] `tools/mint-claudev-code.sh`
- [ ] `.github/workflows/lxc-e2e.yml`
- [ ] `workspace/homelab/ansible/roles/gh-runner-vos/` (role + secrets + README)
- [ ] `workspace/homelab/ansible/playbooks/gh-runner-vos.yml`
- [ ] Runner registered against `makscee/void-os`, label `lxc-tower`, online
- [ ] One green LXC E2E run logged in task Work Log (manual or workflow_dispatch)
