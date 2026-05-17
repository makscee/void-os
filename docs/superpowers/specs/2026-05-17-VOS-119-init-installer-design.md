# VOS-119 — `void-os init` interactive installer design

**Date:** 2026-05-17
**Task:** VOS-119
**Parent milestone:** vos-cli-support / "Tinker Seed Live"

## Context

`void-os init` is the fresh-user bootstrap: one command from clean machine to seeded vault + buildable plugin. Walks preflight → configure → build → seed → plugin-install. The daemon itself is not started by init — plugin (VOS-120) and CLI (VOS-118) auto-spawn it lazily on first use.

The existing `cli/init.ts` does part of the job (copy-tree from `starter-vault/`, skills symlink, plugin dist copy, `--dry-run`/`--force`/`--home` flags). VOS-119 extends it to a complete interactive installer with preflight, prompts, build, git init, optional GH push, and idempotency marker.

Adjacent in-flight or queued work:

| Task | Owns |
|---|---|
| VOS-118 | `void-os ask <agent>` + `chat` subcommands |
| VOS-120 | Plugin thin-client + daemon auto-spawn on Obsidian load |
| VOS-121 | `--non-interactive` flag + LXC headless E2E |
| VOS-122 | Fresh-user README (Mac + LXC) + manual test pass |

Anything those tasks own is **out of scope here**.

## Decisions locked (from brainstorm)

| Decision | Value |
|---|---|
| Default vault path | `~/vault` (bump existing `~/void` default) |
| Templates location | `starter-vault/` (keep existing path; do not move to `scripts/templates/`) |
| Seed agents | Single **tinker** agent (drop `maya`, `journaler`, `task-tracker` from starter-vault) |
| `CLAUDE.md` + `agents/tinker/agent.md` content | Author full versions per migration spec sizes (~80 / ~50 lines) |
| Prompt UX library | `@clack/prompts` |
| `--non-interactive` flag | Deferred — VOS-121 owns it |
| Daemon start in installer | None — plugin (VOS-120) and CLI (VOS-118) lazy-spawn |
| GH integration | `git init` always; `gh repo create --private` + push only if `gh` authed AND user opts in |
| Idempotency | `.void` marker file at vault root; `--force` overrides |
| Build step | `bun install` at repo root + `bun run build` inside `plugin/`; skip if `plugin/dist/main.js` newer than `plugin/src/` |
| Final hint | Obsidian-enable steps + note that CLI `void-os ask tinker "hello"` lands with VOS-118 |

## Phases

```
PREFLIGHT  → CONFIGURE → BUILD → SEED → PLUGIN → REPORT
```

### Preflight

Pure detection. Returns a `PreflightReport`:

```ts
interface PreflightReport {
  os: "darwin" | "linux" | "unknown"
  claude: { found: boolean; version?: string }
  bun: { found: boolean; version?: string }
  gh: { found: boolean; authed: boolean }
  obsidian: { found: boolean }
}
```

Behavior:

- `claude` missing → **hard fail**, print install hint, exit `code 2`.
- `bun` missing on macOS → offer `brew install bun`, run it on confirm. Decline → exit `2`.
- `bun` missing on Linux → print install URL (`https://bun.sh/install`), exit `2`.
- `gh` missing or not authed → soft warning; GH steps marked skipped.
- `obsidian` missing → soft warning; plugin-install step marked skipped (still copy dist into vault `.obsidian/plugins/` since Obsidian might be installed later).

Obsidian detection: macOS = `/Applications/Obsidian.app` exists. Linux = `which obsidian` or `~/.config/Obsidian/` exists.

### Configure

`@clack/prompts` flow:

1. `intro("void-os init")`
2. `text` — vault location, default `~/vault`, validation: absolute path or `~`-prefix.
3. If `gh.authed`: `confirm` — "create private GitHub repo and push initial commit?" → if yes, `text` — repo name, default `vault`.
4. If `obsidian.found`: `text` — Obsidian vault display name, default `void`. Used for plugin enable instructions only.
5. `outro` — summary of decisions, `confirm` to proceed.

`isCancel()` on any prompt → `cancel()` + exit `130`, no writes.

### Build

- `spawnSync('bun', ['install'], { cwd: prefix, stdio: 'inherit' })` — repo root.
- `spawnSync('bun', ['install'], { cwd: prefix + '/plugin', stdio: 'inherit' })` — plugin deps.
- `spawnSync('bun', ['run', 'build'], { cwd: prefix + '/plugin', stdio: 'inherit' })` — produces `plugin/dist/main.js`.

Skip-build heuristic: if `plugin/dist/main.js` mtime newer than newest mtime under `plugin/src/`, skip the plugin build. Always run `bun install` (cheap when up-to-date).

`--skip-build` flag bypasses all build steps for dev iter.

Non-zero exit from any spawn → abort `code 3`.

### Seed

Order matters — git init before file writes so commit captures full tree.

1. **Pre-check.** Read `<vault>/.void` if present.
   - Present + `--force` not set → skip file copies, continue to git/gh steps.
   - Absent + dir non-empty + no `--force` → existing refuse-clobber error (already in `provision()`).
2. **Create vault dir** (`mkdirSync({ recursive: true })`).
3. **`git init`** if `<vault>/.git/` absent.
4. **Copy tree** `<prefix>/starter-vault/` → `<vault>/` via existing `copyTree()`. Existing `--force` semantics preserved.
5. **Claude skills symlink** via existing `ensureClaudeSkillsSymlink()`.
6. **Write `.void` marker** atomically (write to `.void.tmp` + `rename`):

   ```json
   { "version": 1, "createdAt": "<ISO>", "vault": "<abs path>" }
   ```

7. **First commit** if no commits yet: `git add -A && git commit -m "seed: void-os init"`.
8. **GH push** if confirmed:
   - `gh repo create <name> --private --source <vault> --push`
   - Fallback if repo already exists: `git remote add origin git@github.com:<user>/<name>.git || git remote set-url origin ...` then `git push -u origin main`.
   - Failure → soft warn, leave local repo, continue.

### Plugin install

Reuse existing `copyPluginDist()`. Target is `<vault>/.obsidian/plugins/void-os/` (per-vault, Obsidian convention). On dry-run, log target.

### Report

Print one block. Example (Obsidian detected, gh pushed):

```
void-os seeded at /Users/x/vault
  • git initialized + first commit
  • pushed to git@github.com:x/vault.git
  • plugin built and copied to .obsidian/plugins/void-os/

next:
  1. open Obsidian, "Open vault" → /Users/x/vault
  2. Settings → Community plugins → enable "void-os"
  3. chat with Tinker via the plugin's chat pane

CLI access (`void-os ask tinker "hello"`) lands with VOS-118.
```

Variants:
- No Obsidian: drop step 1–2; print Obsidian install URL.
- No gh push: drop push line; print "remote: none (add later with `gh repo create`)".
- Re-run with `.void` present: "void-os already seeded at <path>; re-applied build + plugin only. Pass --force to re-seed templates."

## Data model

### `.void` marker

```ts
interface VoidMarker {
  version: 1
  createdAt: string   // ISO 8601 UTC
  vault: string       // absolute path
}
```

Atomic write contract: write to `<vault>/.void.tmp`, `renameSync` to `.void`. Re-run is allowed to overwrite (idempotent).

### Re-run matrix

| State | `--force` off | `--force` on |
|---|---|---|
| `.void` absent, dir empty | full install | full install |
| `.void` absent, dir non-empty | refuse (existing) | overwrite all |
| `.void` present | preflight + build + plugin only; seed files skipped | re-seed all files |
| `.git/` present | git init skipped | git init skipped |

## Seed templates (authored in this task)

| File | Content shape |
|---|---|
| `starter-vault/CLAUDE.md` | ~80 lines. Wiki schema (folder = state, frontmatter, append-over-rewrite, ISO dates, `ask_user` for irreversible). Agent system primer (what agents are, `write_scope`, `ask_agent`, MCP tool conventions). Replaces current minimal stub. |
| `starter-vault/agents/tinker/agent.md` | ~50 lines. Tinker identity (concierge/lint), `write_scope: [agents/**, CLAUDE.md, README.md, log.md]`, tools, conventions. Per migration spec "The Tinker Seed". |
| `starter-vault/log.md` | Empty file. |
| `starter-vault/README.md` | Short note: "seeded by void-os init; see CLAUDE.md for conventions". |

**Removed:** `starter-vault/agents/maya/agent.md`, `starter-vault/agents/journaler/agent.md`, `starter-vault/agents/task-tracker/agent.md`.

## File layout (after this task)

```
workspace/void-os/
├── cli/
│   ├── init.ts                  # main entry; orchestrates phases
│   ├── init.test.ts             # extended unit + integration
│   └── init/
│       ├── preflight.ts
│       ├── configure.ts
│       ├── build.ts
│       ├── seed.ts              # provision() + .void marker + git
│       └── plugin.ts
├── starter-vault/
│   ├── CLAUDE.md                # rewritten ~80 lines
│   ├── README.md                # short
│   ├── log.md                   # empty
│   └── agents/
│       └── tinker/
│           └── agent.md         # ~50 lines
└── package.json                 # adds @clack/prompts dep
```

## Errors and exit codes

| Exit | Meaning |
|---|---|
| 0 | success |
| 1 | unknown error |
| 2 | preflight failure (missing required: claude or bun) |
| 3 | build failure |
| 4 | seed failure (filesystem or git) |
| 130 | user cancelled (Ctrl-C / clack cancel) |

GH push failure does NOT abort — soft warn only.

## Testing

`cli/init.test.ts` extended:

- **Smoke gate first.** Run existing `init.test.ts` against tmp dirs before adding new cases. Confirms test harness still works after `provision()` refactor into `seed.ts`.
- **Unit:**
  - `preflight()` — stub `which` via mocked `spawnSync`; assert returned report shape.
  - `configure()` — feed scripted answers via clack's test helpers (or wrap behind an injected `Prompter` interface for testability).
  - `seed()` — tmp `prefix` + tmp `home`; assert files copied, `.void` written, `.git/` created.
  - Idempotency — run `seed()` twice; second run should not overwrite without `--force`; `.void` mtime unchanged.
- **Integration:**
  - End-to-end against tmp `$HOME` and tmp prefix. Assert: `<vault>/CLAUDE.md` exists, `<vault>/agents/tinker/agent.md` exists, `<vault>/.void` JSON parses with `version: 1`, `<vault>/.git/` exists, `<vault>/.obsidian/plugins/void-os/main.js` exists.
  - Skip `gh` path (mock `gh` binary absent).

Manual:
- `void-os init` on Mac with clean `~/vault-test` location, gh authed, Obsidian present. Verify all phases.
- `void-os init --force` over existing vault. Verify re-seed.
- `void-os init` re-run without `--force`. Verify skip + correct report.

## Acceptance bullets (final, replacing task file)

1. `void-os init` runs interactively via `@clack/prompts`: vault location (default `~/vault`), GH repo name (if gh authed), Obsidian vault name (if Obsidian found).
2. Preflight detects + reports os, claude CLI, bun, gh auth, Obsidian. Hard-fails on missing claude or bun (with `brew install bun` offer on Mac).
3. Build step: `bun install` at root + `bun install && bun run build` inside `plugin/`. Skips plugin build if dist is current.
4. Seed: creates vault dir, copies `starter-vault/` (CLAUDE.md + `agents/tinker/agent.md` + empty `log.md` + README), writes `.void` marker, `git init`, optional `gh repo create --private --push`.
5. Plugin install: copies `plugin/dist/` to `<vault>/.obsidian/plugins/void-os/`. Prints enable steps if Obsidian detected.
6. Final report: "ready" message with Obsidian enable hint + note that CLI `void-os ask tinker "hello"` lands with VOS-118.
7. Re-running on an already-initialized vault is safe (detects `.void`, skips seed unless `--force`, re-runs build + plugin).
8. Seed templates live in `starter-vault/` and are version-controlled.
9. `starter-vault/CLAUDE.md` encodes wiki schema + agent system primer per migration spec.
10. Existing `maya`, `journaler`, `task-tracker` seed agents removed; replaced with single `tinker` agent.

## Out of scope

- `--non-interactive` flag → VOS-121
- LXC headless E2E → VOS-121
- Plugin auto-spawn on Obsidian load → VOS-120
- `void-os ask <agent>` + `chat` → VOS-118
- Fresh-user README → VOS-122

## References

- Task: `vault/work/tasks/active/VOS-119-void-os-init-installer.md`
- Migration spec: `vault/projects/void-os-migration/specs/2026-05-16-vault-migration-design.md`
- Sibling: `workspace/void-os/cli/init.ts` (current partial implementation)
- VOS-117 (done): `vault/work/tasks/completed/VOS-117-cli-scaffold-daemon-and-introspection.md`
