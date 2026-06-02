# vault-native: running plain `claude` in `~/void/`

Capability 7 (VOS-197). A human typing `claude` in `~/void/` is a first-class void-os
execution — same executions row, same files-first event log, same output_target detection
and bus-nudge capability as a daemon-spawned exec. No wrapper, no flags needed.

## How it works

`~/void/` is a **generated/synced** vault. Its `.claude/` directory (settings, hooks, skills,
agents) is produced from the void-os repo by the `void-os init` command. The repo is the
source of truth; `~/void/.claude/` is the live deployed instance.

When `claude` starts in `~/void/`, the vault-level `settings.json` fires a `SessionStart`
hook that POSTs to the void-os daemon. The daemon derives a stable `runId` from CC's
`session_id` and creates an `executions` row on the spot. The existing VOS-191 Stop hook
then closes the row and runs output detection when the session ends.

### No direct symlink into the repo working tree

`~/void/.claude/skills` is a **generated directory** (not a symlink into the repo). This
avoids the worktree-collision class where removing a worktree breaks the live vault.

---

## Install / first-time setup

```bash
# 1. Build void-os (if not already installed globally)
cd /path/to/void-os-repo
bun install

# 2. Initialise the vault — generates .claude/ structure + lifecycle hooks
void-os init ~/void/

# Output:
#   void-os vault ready at /Users/<you>/void
#     start it with: void-os serve
```

This writes:
- `~/void/.claude/settings.json` — lifecycle hooks pointing to `http://127.0.0.1:4317`
  (or `VOID_OS_DAEMON_URL` if set)
- `~/void/.claude/skills/` — all catalog skills copied in (including `vault-native-smoke`,
  `idea-intake`, `onboarding`, `work`, etc.)
- `~/void/.claude/agents/` — catalog agents
- `~/void/CLAUDE.md` — vault-level context file
- `~/void/sessions/` — session state directory

---

## Re-sync after repo changes

The repo is the source of truth. After pulling new void-os commits (new skills, updated
hooks, changed relay script), re-sync the vault:

```bash
void-os init ~/void/
```

`init` is **idempotent** — re-running it updates `settings.json` + overwrites skills/agents
with the latest catalog versions. Your vault data (executions, inbox, tasks, notes) is not
touched.

### If you changed `VOID_OS_DAEMON_URL`:

```bash
VOID_OS_DAEMON_URL=http://127.0.0.1:9000 void-os init ~/void/
```

This regenerates `settings.json` with the new daemon URL baked in.

---

## Start the daemon

```bash
cd ~/void/
void-os serve
```

The daemon must be running for the vault-level hooks to register executions.

---

## Use: plain `claude` in `~/void/`

```bash
cd ~/void/
claude                         # interactive: opens a CC session
claude -p "/vault-native-smoke"  # headless print-mode: runs a skill
claude -p "/idea-intake" "add a search feature to void-admin"
```

Every session — interactive or headless — self-registers as a real `executions` row via
the vault-level `SessionStart` hook. No `--settings` flag, no wrapper.

---

## MCP registration

The void-os MCP server is not auto-registered in `~/void/.claude/` by `init` today. To
register it manually (for tools like `mcp__void-os__*`):

```bash
# Add to ~/void/.claude/mcp.json (create if absent):
{
  "mcpServers": {
    "void-os": {
      "command": "bun",
      "args": ["run", "/path/to/void-os-repo/src/mcp.ts"]
    }
  }
}
```

Auto-registration via `init` is tracked as a future improvement.

---

## Verify

After setup, run the VOS-197 proof to confirm everything is wired correctly:

```bash
cd /path/to/void-os-repo
bash scripts/vos-proof-vos197.sh
# → PROOF PASSED: all checks green
```
